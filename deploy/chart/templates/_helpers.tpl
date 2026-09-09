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
