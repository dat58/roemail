#!/usr/bin/env bash
# Manage domains / mailboxes for Stalwart.
# Since v0.16, the old /api/... REST API is gone; admin operations (create/delete
# domain, mailbox) use stalwart-cli (https://stalw.art/docs/management/cli).
# Reading mail still uses plain JMAP via curl/jq (unchanged from before).
# Requires: curl, jq, openssl, stalwart-cli
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
API="${STALWART_API:-http://127.0.0.1:8080}"
: "${ADMIN_PASSWORD:?Missing ADMIN_PASSWORD in .env}"

for c in curl jq openssl stalwart-cli; do
  command -v "$c" >/dev/null || { echo "Please install '$c'" >&2; exit 1; }
done

export STALWART_URL="$API"
export STALWART_USER="admin"
export STALWART_PASSWORD="$ADMIN_PASSWORD"

# Find the id of an object via stalwart-cli query (one or more --where); empty if not found.
find_id() { # object_type where1 [where2...]
  local type=$1; shift
  local args=(query "$type" --fields id --json)
  for w in "$@"; do args+=(--where "$w"); done
  stalwart-cli "${args[@]}" | jq -r '.id // empty' | head -n1
}

usage() {
  cat <<U
Usage:
  $0 domain <domain>                         Create a domain (once per domain)
  $0 user <email> [password] [quota_MB]      Create a mailbox (password auto-generated if omitted)
  $0 list                                    List accounts
  $0 delete <email>                          Delete an account
  $0 info <email> <password>                 Print ACCOUNT_ID and INBOX_ID for Worker config
  $0 read <email> <password> [n]             Read the n most recent INBOX emails (default 10)
U
  exit 1
}

cmd=${1:-}; shift || true
case "$cmd" in
  domain)
    d=${1:?missing domain}
    stalwart-cli create Domain --field "name=$d" --field "description=$d" >/dev/null
    echo "Domain created: $d"
    ;;

  user)
    email=${1:?missing email}
    pass=${2:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)}
    quota_mb=${3:-0}
    name=${email%@*}      # login name = part before @
    domain=${email#*@}

    domain_id=$(find_id Domain "name=$domain")
    [ -n "$domain_id" ] || { echo "Domain '$domain' does not exist yet. Run first: $0 domain $domain" >&2; exit 1; }

    cred=$(jq -nc --arg p "$pass" '{"0":{"@type":"Password",secret:$p}}')
    fields=(--field "name=$name" --field "domainId=$domain_id" --field "credentials=$cred")
    if [ "$quota_mb" -gt 0 ]; then
      quota=$(jq -nc --argjson q "$((quota_mb*1024*1024))" '{maxDiskQuota:$q}')
      fields+=(--field "quotas=$quota")
    fi
    stalwart-cli create Account/User "${fields[@]}" >/dev/null

    echo "Mailbox created"
    echo "  Email:    $email"
    echo "  Username: $name"
    echo "  Password: $pass"
    echo "Get the ID for a Worker: $0 info $email '<password>'"
    ;;

  list)
    stalwart-cli query Domain --fields name --json 2>/dev/null \
      | jq -r '["domain", .name, ""] | @tsv'
    stalwart-cli query Account --fields name,emailAddress --json 2>/dev/null \
      | jq -r '["individual", .name, .emailAddress] | @tsv'
    ;;

  delete)
    email=${1:?missing email}
    name=${email%@*}
    domain=${email#*@}
    domain_id=$(find_id Domain "name=$domain")
    [ -n "$domain_id" ] || { echo "Domain '$domain' does not exist" >&2; exit 1; }
    id=$(find_id Account "name=$name" "domainId=$domain_id")
    [ -n "$id" ] || { echo "Account not found: $email" >&2; exit 1; }
    stalwart-cli delete Account --ids "$id" >/dev/null
    echo "Deleted: $email"
    ;;

  info)
    email=${1:?missing email}; pass=${2:?missing password}
    session=$(curl -sS -u "${email}:${pass}" "${API}/jmap/session")
    acc=$(echo "$session" | jq -r '.primaryAccounts["urn:ietf:params:jmap:mail"] // empty')
    [ -n "$acc" ] || { echo "Login failed or could not fetch session" >&2; exit 1; }
    req=$(jq -n --arg a "$acc" '{using:["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
      methodCalls:[["Mailbox/get",{accountId:$a},"0"]]}')
    inbox=$(curl -sS -u "${email}:${pass}" -H 'Content-Type: application/json' -d "$req" "${API}/jmap/" \
      | jq -r '.methodResponses[0][1].list[] | select(.role=="inbox") | .id')
    echo "ACCOUNT_ID=$acc"
    echo "INBOX_ID=$inbox"
    echo "JMAP_USER=$email"
    ;;

  read)
    email=${1:?missing email}; pass=${2:?missing password}; n=${3:-10}
    session=$(curl -sS -u "${email}:${pass}" "${API}/jmap/session")
    acc=$(echo "$session" | jq -r '.primaryAccounts["urn:ietf:params:jmap:mail"] // empty')
    [ -n "$acc" ] || { echo "Login failed or could not fetch session" >&2; exit 1; }

    mreq=$(jq -n --arg a "$acc" '{using:["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
      methodCalls:[["Mailbox/get",{accountId:$a},"0"]]}')
    inbox=$(curl -sS -u "${email}:${pass}" -H 'Content-Type: application/json' -d "$mreq" "${API}/jmap/" \
      | jq -r '.methodResponses[0][1].list[] | select(.role=="inbox") | .id')
    [ -n "$inbox" ] || { echo "INBOX mailbox not found" >&2; exit 1; }

    ereq=$(jq -n --arg a "$acc" --arg m "$inbox" --argjson n "$n" \
      '{using:["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
        methodCalls:[
          ["Email/query",{accountId:$a, filter:{inMailbox:$m}, sort:[{property:"receivedAt", isAscending:false}], limit:$n}, "q"],
          ["Email/get",{accountId:$a, "#ids":{resultOf:"q", name:"Email/query", path:"/ids"},
            properties:["id","subject","from","receivedAt","preview","keywords","textBody","htmlBody","bodyValues"],
            fetchTextBodyValues:true, fetchHTMLBodyValues:true}, "g"]
        ]}')
    list=$(curl -sS -u "${email}:${pass}" -H 'Content-Type: application/json' -d "$ereq" "${API}/jmap/" \
      | jq '.methodResponses[1][1].list')

    if [ "$(echo "$list" | jq 'length')" -eq 0 ]; then
      echo "No emails in INBOX."
    else
      # Prefer the full text/plain body (bodyValues is not truncated the way
      # the "preview" field is, which is always capped at 256 chars); fall
      # back to HTML (tags stripped) only when there's no text/plain part.
      echo "$list" | jq -r '
        .[] | . as $e
        | ($e.bodyValues // {}) as $bv
        | ($e.textBody // []) as $tb
        | ($e.htmlBody // []) as $hb
        | (if ($tb|length) > 0 then
             [$tb[] | $bv[.partId].value // ""] | join("\n")
           elif ($hb|length) > 0 then
             ([$hb[] | $bv[.partId].value // ""] | join("\n"))
             | gsub("<(script|style)[^>]*>.*?</(script|style)>"; ""; "img")
             | gsub("<br\\s*/?>"; "\n"; "i")
             | gsub("</p>"; "\n\n"; "i")
             | gsub("<[^>]+>"; "")
             | gsub("&nbsp;"; " ") | gsub("&lt;"; "<") | gsub("&gt;"; ">") | gsub("&amp;"; "&")
             | gsub("\n[ \t]*\n[ \t]*\n+"; "\n\n")
           else
             ($e.preview // "(no content)")
           end) as $body
        | "[\(if $e.keywords["$seen"] then "read" else "NEW " end)] \($e.receivedAt)  \($e.from[0].name // $e.from[0].email // "?")  — \($e.subject // "(no subject)")\n\($body | gsub("\r\n";"\n") | split("\n") | map("    " + .) | join("\n"))\n"
      '
    fi
    ;;

  *) usage ;;
esac
