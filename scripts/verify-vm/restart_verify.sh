cd "$(dirname "$0")" || exit 1
until [ "$(gcloud compute instances describe policy-verifier --zone us-central1-a --format='value(status)')" = "TERMINATED" ]; do sleep 20; done
date
bash tick.sh >/dev/null 2>&1
A=$(sed -n 's/^本輪 agents：//p' decision.txt); echo "$A"
[ -z "$A" ] && { echo "agents 空的，不開機"; exit 1; }
gcloud compute instances add-metadata policy-verifier --zone us-central1-a --metadata "run-hours=1,verify-only=1,agents=$A" >/dev/null 2>&1 && gcloud compute instances start policy-verifier --zone us-central1-a 2>&1 | tail -1
for i in $(seq 1 20); do n=$(gcloud compute instances get-serial-port-output policy-verifier --zone us-central1-a 2>/dev/null | grep -c "AGENT-START"); [ "$n" -ge 4 ] && break; sleep 15; done
gcloud compute instances get-serial-port-output policy-verifier --zone us-central1-a 2>/dev/null | grep -o "AGENT-START name=[^ ]*"; date
