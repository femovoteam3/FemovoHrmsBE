#!/bin/bash
# Builds the app, uploads it and installs it on the server. Run from Git Bash after `aws login --profile Femovo-HRMS`.
set -euo pipefail
export PATH="$HOME/AppData/Local/Programs/Amazon/AWSCLIV2:$PATH" PYTHONUTF8=1 AWS_PAGER= MSYS_NO_PATHCONV=1
AWS_ARGS=(--profile Femovo-HRMS --region ap-southeast-2)
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

output() { aws cloudformation describe-stacks --stack-name femovo-hrms "${AWS_ARGS[@]}" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(output ReleaseBucketName); INSTANCE=$(output InstanceId); SITE=$(output SiteUrl); DB=$(output DbHost)
DB_SECRET=$(output DbSecretArn); JWT=$(output JwtSecretArn); ADMIN=$(output AdminSecretArn)

cd "$ROOT"
RELEASE="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
echo "Building release $RELEASE"
npm run build --silent
TAR=$(mktemp -u).tar.gz
tar -czf "$TAR" --exclude='.env' --exclude='.env.*' --exclude='server/uploads' --exclude='node_modules' package.json package-lock.json server client/dist
if tar -tzf "$TAR" | grep -E '(^|/)\.env|server/uploads'; then echo "Refusing: secrets or uploads in the bundle"; exit 1; fi

aws s3 cp --only-show-errors "$(cygpath -m "$TAR")" "s3://$BUCKET/releases/$RELEASE.tar.gz" "${AWS_ARGS[@]}"
aws s3 cp --only-show-errors "$(cygpath -m "$HERE/remote-deploy.sh")" "s3://$BUCKET/releases/$RELEASE.sh" "${AWS_ARGS[@]}"
rm -f "$TAR"

PARAMS=$(mktemp)
node -e "
const [bucket,release,...rest]=process.argv.slice(1);
const args=[bucket,release,...rest].map(a=>\"'\"+a+\"'\").join(' ');
process.stdout.write(JSON.stringify({commands:[
  'set -e',
  'aws s3 cp --region ap-southeast-2 --only-show-errors s3://'+bucket+'/releases/'+release+'.sh /root/remote-deploy.sh',
  'bash /root/remote-deploy.sh '+args
],executionTimeout:['1200']}));
" "$BUCKET" "$RELEASE" "$SITE" "$DB" "$DB_SECRET" "$JWT" "$ADMIN" > "$PARAMS"

CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 600 --parameters "file://$(cygpath -m "$PARAMS")" --query Command.CommandId --output text "${AWS_ARGS[@]}")
rm -f "$PARAMS"
echo "SSM command $CMD running on $INSTANCE"
while :; do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)
  case "$STATUS" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 10
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query StandardOutputContent --output text "${AWS_ARGS[@]}"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query StandardErrorContent --output text "${AWS_ARGS[@]}" | tail -20
echo "Deploy status: $STATUS"
[ "$STATUS" = "Success" ]
echo "Live at $SITE"
