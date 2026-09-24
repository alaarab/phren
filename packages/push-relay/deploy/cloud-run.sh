#!/bin/sh
# Deploys the relay to Cloud Run in two regions, each capped at one instance so
# a flood can't run up a bill (excess requests are refused, not scaled).
#   deploy/cloud-run.sh <project-id> <path-to-AuthKey.p8> <key-id> <team-id>
# Secrets live in Secret Manager: the relay secret is created once and reused,
# since a new one makes every phone register again.
set -eu
PROJECT=$1 KEY_FILE=$2 KEY_ID=$3 TEAM_ID=$4
REGIONS=${REGIONS:-"us-central1 us-east4"}
cd "$(dirname "$0")/.."
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com >/dev/null
secret() {
  if ! gcloud secrets describe "$1" >/dev/null 2>&1; then
    gcloud secrets create "$1" --replication-policy=automatic >/dev/null
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  fi
}
secret phren-relay-secret "$(openssl rand -hex 32)"
secret phren-apns-key "$(cat "$KEY_FILE")"
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
for name in phren-relay-secret phren-apns-key; do
  gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done
for region in $REGIONS; do
  gcloud run deploy phren-push-relay --source . --region "$region" --allow-unauthenticated \
    --min-instances 0 --max-instances 1 --concurrency 80 --cpu 1 --memory 256Mi --timeout 30 \
    --set-env-vars "APNS_KEY_ID=$KEY_ID,APNS_TEAM_ID=$TEAM_ID,APNS_TOPIC=com.phren.ios" \
    --set-secrets "PHREN_RELAY_SECRET=phren-relay-secret:latest,APNS_KEY=phren-apns-key:latest" --quiet
  echo "$region: $(gcloud run services describe phren-push-relay --region "$region" --format='value(status.url)')"
done
