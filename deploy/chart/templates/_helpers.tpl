{{- define "frontdesk.name" -}}
frontdesk
{{- end -}}

{{- define "frontdesk.labels" -}}
app.kubernetes.io/name: {{ include "frontdesk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "frontdesk.web.fullname" -}}
{{ include "frontdesk.name" . }}-web
{{- end -}}

{{- define "frontdesk.web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "frontdesk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end -}}

{{- define "frontdesk.web.labels" -}}
{{ include "frontdesk.labels" . }}
app.kubernetes.io/component: web
{{- end -}}

{{- define "frontdesk.web.serviceAccountName" -}}
{{- if .Values.web.serviceAccount.create -}}
{{- default (include "frontdesk.web.fullname" .) .Values.web.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.web.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "frontdesk.web.image" -}}
{{- if .Values.web.image.digest -}}
{{ .Values.web.image.repository }}@{{ .Values.web.image.digest }}
{{- else -}}
{{ .Values.web.image.repository }}:{{ .Values.web.image.tag }}
{{- end -}}
{{- end -}}

{{- define "frontdesk.api.fullname" -}}
{{ include "frontdesk.name" . }}-api
{{- end -}}

{{- define "frontdesk.api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "frontdesk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: api
{{- end -}}

{{- define "frontdesk.api.labels" -}}
{{ include "frontdesk.labels" . }}
app.kubernetes.io/component: api
{{- end -}}

{{- define "frontdesk.api.serviceAccountName" -}}
{{- if .Values.api.serviceAccount.create -}}
{{- default (include "frontdesk.api.fullname" .) .Values.api.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.api.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "frontdesk.api.image" -}}
{{- if .Values.api.image.digest -}}
{{ .Values.api.image.repository }}@{{ .Values.api.image.digest }}
{{- else -}}
{{ .Values.api.image.repository }}:{{ .Values.api.image.tag }}
{{- end -}}
{{- end -}}

{{- define "frontdesk.worker.fullname" -}}
{{ include "frontdesk.name" . }}-worker
{{- end -}}

{{- define "frontdesk.worker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "frontdesk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end -}}

{{- define "frontdesk.worker.labels" -}}
{{ include "frontdesk.labels" . }}
app.kubernetes.io/component: worker
{{- end -}}

{{- define "frontdesk.worker.serviceAccountName" -}}
{{- if .Values.worker.serviceAccount.create -}}
{{- default (include "frontdesk.worker.fullname" .) .Values.worker.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.worker.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "frontdesk.worker.image" -}}
{{- if .Values.worker.image.digest -}}
{{ .Values.worker.image.repository }}@{{ .Values.worker.image.digest }}
{{- else -}}
{{ .Values.worker.image.repository }}:{{ .Values.worker.image.tag }}
{{- end -}}
{{- end -}}

{{/*
Every component's pod template gets this in addition to its own
selectorLabels - deliberately NOT folded into selectorLabels/labels,
because selectorLabels doubles as a Deployment/StatefulSet's
spec.selector.matchLabels, which is immutable on update. Adding a label
there would break `helm upgrade` on any resource already live in the
cluster. This is purely additive on the pod template, never on a
selector, so it's always safe to add here (ADR-0016's NetworkPolicy for
postgres matches on it).
*/}}
{{- define "frontdesk.partOf" -}}
app.kubernetes.io/part-of: frontdesk
{{- end -}}

{{- define "frontdesk.postgres.fullname" -}}
{{ include "frontdesk.name" . }}-postgres
{{- end -}}

{{- define "frontdesk.postgres.headlessFullname" -}}
{{ include "frontdesk.postgres.fullname" . }}-headless
{{- end -}}

{{/*
Fixed name, not derived from frontdesk.postgres.fullname: ADR-0016 names
this PVC frontdesk-db-backups specifically, and the VPS pull cron
(deploy/postgres/README.md) hardcodes that name in its rsync source path.
*/}}
{{- define "frontdesk.postgres.backupsFullname" -}}
frontdesk-db-backups
{{- end -}}

{{/*
Fixed name too: ADR-0016 names the CronJob frontdesk-db-backup in its
decision and acceptance criteria (`kubectl create job --from=cronjob/frontdesk-db-backup`).
*/}}
{{- define "frontdesk.postgres.backupCronJobName" -}}
frontdesk-db-backup
{{- end -}}

{{/*
Backup pods must NOT carry frontdesk.postgres.selectorLabels: the
frontdesk-postgres Services select on those, so a backup pod would become
a database endpoint (nothing listening on 5432 -> "connection refused"
for every other client, including the backup itself). Found on #20's
first acceptance run. Distinct component, same part-of for NetworkPolicy.
*/}}
{{- define "frontdesk.postgres.backupLabels" -}}
{{ include "frontdesk.labels" . }}
app.kubernetes.io/component: postgres-backup
{{- end -}}

{{- define "frontdesk.postgres.selectorLabels" -}}
app.kubernetes.io/name: {{ include "frontdesk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end -}}

{{- define "frontdesk.postgres.labels" -}}
{{ include "frontdesk.labels" . }}
app.kubernetes.io/component: postgres
{{- end -}}

{{- define "frontdesk.postgres.image" -}}
{{- if .Values.postgres.image.digest -}}
{{ .Values.postgres.image.repository }}@{{ .Values.postgres.image.digest }}
{{- else -}}
{{ .Values.postgres.image.repository }}:{{ .Values.postgres.image.tag }}
{{- end -}}
{{- end -}}

{{- define "frontdesk.db.image" -}}
{{- if .Values.db.image.digest -}}
{{ .Values.db.image.repository }}@{{ .Values.db.image.digest }}
{{- else -}}
{{ .Values.db.image.repository }}:{{ .Values.db.image.tag }}
{{- end -}}
{{- end -}}

{{/*
Fixed name, not derived from frontdesk.name: ADR-0018 and ADR-0019 both
name this Job frontdesk-db-migrate in their decision and acceptance text
(`kubectl -n frontdesk logs job/frontdesk-db-migrate`).
*/}}
{{- define "frontdesk.db.migrateJobName" -}}
frontdesk-db-migrate
{{- end -}}

{{/*
Must not match any Service selector, same reasoning as
frontdesk.postgres.backupLabels (#75: a backup pod became a Postgres
endpoint because it carried the Service's selector labels). This Job's
pod carries no component-specific selector labels anywhere else in the
chart, but the component label is still its own value, not "postgres" or
"web", so a future Service selecting on component can't accidentally
pick it up either.
*/}}
{{- define "frontdesk.db.migrateLabels" -}}
{{ include "frontdesk.labels" . }}
app.kubernetes.io/component: db-migrate
{{- end -}}
