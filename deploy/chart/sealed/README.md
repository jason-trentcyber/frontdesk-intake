# deploy/chart/sealed/

SealedSecret manifests, one file per secret, applied by the `frontdesk`
Helm release via `templates/sealed-secrets.yaml` (a glob over `*.yaml` in
this directory). A SealedSecret is ciphertext encrypted against the
sealed-secrets controller's public key (`deploy/bootstrap/sealed-secrets-pub.pem`)
for a specific namespace + secret name; only that controller, running in
this cluster, can decrypt it. It is safe to commit.

**Nothing plaintext is ever written here, by a human or an agent.**

## Adding one (human only - see docs/AI-GOVERNANCE.md)

```
kubectl create secret generic <name> -n frontdesk \
  --from-literal=<key>=<value> \
  --dry-run=client -o yaml \
  | kubeseal --cert deploy/bootstrap/sealed-secrets-pub.pem -o yaml \
  > deploy/chart/sealed/<name>.sealed.yaml
```

Commit the resulting file. The next `helm upgrade` picks it up
automatically.

## Turnstile (#18/#27)

`turnstile.sealed.yaml` seals the Turnstile secret key (`infra/cloudflare`
output `turnstile_secret_key`) as a `Secret` named `turnstile` with key
`secret-key`, referenced by the `web` Deployment's `TURNSTILE_SECRET_KEY`
env var (`optional: true`, since #27 is the first real consumer):

```
terraform -chdir=infra/cloudflare output -raw turnstile_secret_key \
  | kubectl create secret generic turnstile -n frontdesk \
      --from-literal=secret-key=/dev/stdin \
      --dry-run=client -o yaml \
  | kubeseal --cert deploy/bootstrap/sealed-secrets-pub.pem -o yaml \
  > deploy/chart/sealed/turnstile.sealed.yaml
```
