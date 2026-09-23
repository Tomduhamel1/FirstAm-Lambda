#!/bin/zsh
# ZipCodes placeholder cleanup runner.
# 1) raises write capacity 1 -> 25 for the run, 2) applies batches/*.json with
#    batch-write-item (retrying UnprocessedItems), 3) restores write capacity to 1.
# Safe to re-run: puts are idempotent, deletes of missing keys are no-ops.
set -u
export AWS_PROFILE=fnte AWS_REGION=us-east-1
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/cleanup.log"
TABLE=ZipCodes

wait_active() { aws dynamodb wait table-exists --table-name $TABLE; until [ "$(aws dynamodb describe-table --table-name $TABLE --query 'Table.TableStatus' --output text)" = "ACTIVE" ]; do sleep 5; done; }

echo "$(date -u +%FT%TZ) start" | tee -a "$LOG"
aws dynamodb update-table --table-name $TABLE --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=25 --query 'TableDescription.TableStatus' --output text | tee -a "$LOG"
wait_active
echo "$(date -u +%FT%TZ) write capacity raised" | tee -a "$LOG"

done_count=0; fail_count=0
for f in "$DIR"/batches/b*.json; do
  req="$f"; attempt=0
  while :; do
    attempt=$((attempt+1))
    out=$(aws dynamodb batch-write-item --request-items "file://$req" --output json 2>>"$LOG") || { echo "  error on $(basename $f) attempt $attempt" >> "$LOG"; sleep $((attempt*2)); [ $attempt -ge 6 ] && { fail_count=$((fail_count+1)); break; }; continue; }
    unp=$(echo "$out" | jq -c '.UnprocessedItems // {}')
    if [ "$unp" = "{}" ] || [ "$(echo "$unp" | jq '.ZipCodes|length')" = "0" ] 2>/dev/null; then break; fi
    echo "$unp" > "$DIR/unprocessed.json"; req="$DIR/unprocessed.json"; sleep $((attempt))
    [ $attempt -ge 8 ] && { echo "  gave up on unprocessed for $(basename $f)" >> "$LOG"; fail_count=$((fail_count+1)); break; }
  done
  done_count=$((done_count+1))
  [ $((done_count % 25)) -eq 0 ] && echo "$(date -u +%FT%TZ) $done_count batches applied" | tee -a "$LOG"
  sleep 0.6
done

echo "$(date -u +%FT%TZ) batches=$done_count failures=$fail_count" | tee -a "$LOG"
aws dynamodb update-table --table-name $TABLE --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 --query 'TableDescription.TableStatus' --output text | tee -a "$LOG"
echo "$(date -u +%FT%TZ) write capacity restored to 1; done" | tee -a "$LOG"
