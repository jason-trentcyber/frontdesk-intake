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
