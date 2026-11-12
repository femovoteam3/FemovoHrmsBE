#!/bin/bash
# Runs on the EC2 server through SSM. Usage: remote-deploy.sh <bucket> <release> <site-url> <db-host> <db-secret> <jwt-secret> <admin-secret>
set -euo pipefail
BUCKET=$1; RELEASE=$2; SITE_URL=$3; DB_HOST=$4; DB_SECRET=$5; JWT_SECRET_ARN=$6; ADMIN_SECRET=$7
REGION=ap-southeast-2
NODE_VERSION=24.21.0
APP=/opt/femovo
ENV_FILE=/etc/femovo/app.env
UPLOADS=/var/lib/femovo/uploads

secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

echo "== system packages"
command -v jq >/dev/null || dnf install -y -q jq

echo "== swapfile"
if ! swapon --show | grep -q '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "== node $NODE_VERSION"
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  file="node-v$NODE_VERSION-linux-arm64.tar.xz"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
export PATH=/opt/node/bin:$PATH

echo "== release $RELEASE"
id femovo >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /sbin/nologin femovo
mkdir -p "$APP/releases" /etc/femovo "$UPLOADS"
chown -R femovo:femovo /var/lib/femovo
chmod 700 "$UPLOADS"
curl -fsSL -o "$APP/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
dir="$APP/releases/$RELEASE"
rm -rf "$dir" && mkdir -p "$dir"
aws s3 cp --region "$REGION" --only-show-errors "s3://$BUCKET/releases/$RELEASE.tar.gz" - | tar -xz -C "$dir"
(cd "$dir" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$dir"

echo "== configuration"
db=$(secret "$DB_SECRET")
umask 077
{
  echo "NODE_ENV=production"
  echo "PORT=5000"
  echo "PGHOST=$DB_HOST"
  echo "PGPORT=5432"
  echo "PGUSER=$(jq -r .username <<<"$db")"
  echo "PGPASSWORD=$(jq -r .password <<<"$db")"
  echo "PGDATABASE=femovo"
  echo "PGSSL=true"
  echo "PGSSLROOTCERT=$APP/rds-global-bundle.pem"
  echo "JWT_SECRET=$(secret "$JWT_SECRET_ARN")"
  echo "JWT_EXPIRES_IN=1h"
  echo "CORS_ORIGIN=$SITE_URL"
  echo "TRUST_PROXY_HOPS=1"
  echo "UPLOAD_DIR=$UPLOADS"
  echo "BUSINESS_TIMEZONE=Asia/Kolkata"
} > "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"
umask 022

echo "== migrations"
(set -a; . "$ENV_FILE"; set +a; cd "$dir" && node server/migrate.js)

echo "== first administrator"
admin=$(secret "$ADMIN_SECRET")
(set -a; . "$ENV_FILE"; set +a; cd "$dir"
 BOOTSTRAP_EMAIL=$(jq -r .email <<<"$admin") BOOTSTRAP_PASSWORD=$(jq -r .password <<<"$admin") node server/bootstrap-admin.js) || echo "bootstrap skipped (an administrator already exists)"

echo "== service"
cat > /etc/systemd/system/femovo.service <<EOF
[Unit]
Description=FEMOVO HRMS
After=network-online.target
Wants=network-online.target

[Service]
User=femovo
Group=femovo
WorkingDirectory=$APP/current
EnvironmentFile=$ENV_FILE
ExecStart=/opt/node/bin/node --max-old-space-size=512 server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$UPLOADS

[Install]
WantedBy=multi-user.target
EOF
ln -sfn "$dir" "$APP/current"
systemctl daemon-reload
systemctl enable --quiet femovo
systemctl restart femovo

echo "== readiness"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/api/ready || true)
  if [ "$code" = "200" ]; then echo "ready after $i checks"; ls -1dt "$APP"/releases/* | tail -n +4 | xargs -r rm -rf; exit 0; fi
  sleep 2
done
echo "not ready, last status $code"
journalctl -u femovo -n 30 --no-pager | cut -c1-220
exit 1
