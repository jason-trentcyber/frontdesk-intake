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

`--from-literal` takes the value **verbatim**. When the value comes from a
pipe rather than being typed, use `--from-file=<key>=/dev/stdin` instead —
see the Turnstile recipe below for why.

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
      --from-file=secret-key=/dev/stdin \
      --dry-run=client -o yaml \
  | kubeseal --cert deploy/bootstrap/sealed-secrets-pub.pem -o yaml \
  > deploy/chart/sealed/turnstile.sealed.yaml
```

**`--from-file`, not `--from-literal`.** This recipe originally said
`--from-literal=secret-key=/dev/stdin`, which does not read stdin:
`--from-literal` takes its value verbatim, so it seals the 10-character
string `/dev/stdin` and discards the piped key entirely. Nothing catches
it — the SealedSecret is structurally valid, commits, renders, deploys,
and the controller decrypts it to a `turnstile` Secret whose `secret-key`
is `/dev/stdin`. The only symptom is Turnstile rejecting every form
submission in production. `--from-file` is the flag that reads a file
path, and `/dev/stdin` is a file path.

Verify the length before committing, without ever decrypting it — the
sealed ciphertext grows with the plaintext, so the bug is visible as a
short envelope:

```
grep -oP 'secret-key: \K\S+' deploy/chart/sealed/turnstile.sealed.yaml | wc -c
```

~721 means the `/dev/stdin` bug; a real ~35-character Turnstile key seals
to ~757. (`terraform output -raw` emits no trailing newline, so the key
arrives exactly as stored.)
