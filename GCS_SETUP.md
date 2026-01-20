# Google Cloud Storage Setup - WhatsApp Document Upload

## Objetivo

Fazer upload de documentos do WhatsApp para Google Cloud Storage e substituir a URL no webhook antes de enviar para o Chatwoot.

## Passos de Configuração

### 1. Criar Bucket no Google Cloud Storage

```bash
# Acesse: https://console.cloud.google.com/storage/browser
# Ou use gcloud CLI:

gcloud storage buckets create gs://chatwoot-whatsapp-media \
  --location=us-east1 \
  --uniform-bucket-level-access
```

### 2. Configurar Permissões Públicas

```bash
# Tornar bucket público para leitura
gsutil iam ch allUsers:objectViewer gs://chatwoot-whatsapp-media

# Ou via Console:
# Storage > Bucket > Permissions > Add Principal
# - Principal: allUsers
# - Role: Storage Object Viewer
```

### 3. Criar Service Account

```bash
# 1. Acesse: https://console.cloud.google.com/iam-admin/serviceaccounts
# 2. Criar Service Account:
#    - Nome: wa-webhook-router
#    - ID: wa-webhook-router
# 3. Conceder role: Storage Object Admin
# 4. Criar chave JSON e baixar
```

Ou via CLI:

```bash
# Criar service account
gcloud iam service-accounts create wa-webhook-router \
  --display-name="WhatsApp Webhook Router" \
  --description="Service account for uploading WhatsApp media to GCS"

# Conceder permissões ao bucket
gcloud storage buckets add-iam-policy-binding \
  gs://chatwoot-whatsapp-media \
  --member="serviceAccount:wa-webhook-router@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Criar e baixar chave JSON
gcloud iam service-accounts keys create gcs-credentials.json \
  --iam-account=wa-webhook-router@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 4. Copiar Credenciais para o Servidor

```bash
# Copiar arquivo JSON para o diretório do projeto
scp gcs-credentials.json user@server:/home/linkiez/projetos/wa-webhook-router/

# Ou criar manualmente:
cd /home/linkiez/projetos/wa-webhook-router
nano gcs-credentials.json
# Colar conteúdo do JSON baixado
```

### 5. Configurar Variáveis de Ambiente

Editar `.env`:

```bash
cd /home/linkiez/projetos/wa-webhook-router
nano .env
```

Adicionar/modificar:

```env
# WhatsApp API Token
WHATSAPP_API_TOKEN=EAAxxxxxxxxxxxxxxxxxx

# Google Cloud Storage
GCS_BUCKET=chatwoot-whatsapp-media
GCS_CREDENTIALS_PATH=/app/gcs-credentials.json
```

### 6. Rebuild e Deploy

```bash
cd /home/linkiez/projetos/wa-webhook-router

# Commit changes
git add .
git commit -m "feat: Add Google Cloud Storage integration for document uploads"
git push

# Rebuild Docker
docker compose build

# Deploy
docker compose up -d

# Ver logs
docker compose logs -f
```

## Verificação

### Testar Upload

Envie um documento pelo WhatsApp e verifique logs:

```bash
docker compose logs -f | grep -E "GCS|Document|Upload"
```

**Logs esperados:**

```
[GCS] Initialized with bucket: chatwoot-whatsapp-media
[SQS Consumer] Document detected: arquivo.pdf ID: 1234567890
[Media Download] Successfully downloaded media, size: 52341 bytes
[GCS Upload] Uploading to: whatsapp-documents/1768926543210-arquivo.pdf
[GCS Upload] Successfully uploaded, URL: https://storage.googleapis.com/chatwoot-whatsapp-media/whatsapp-documents/1768926543210-arquivo.pdf
[SQS Consumer] Replaced document URL with GCS URL
[SQS Consumer] Forwarding with GCS document URL
[SQS Consumer] Successfully forwarded message
```

### Verificar no Google Cloud Console

1. Acesse: https://console.cloud.google.com/storage/browser/chatwoot-whatsapp-media
2. Navegue: `whatsapp-documents/`
3. Verifique se arquivos estão aparecendo
4. Clique em um arquivo → Teste se abre no navegador

### Verificar no Chatwoot

1. Abra conversa no Chatwoot
2. Documento deve aparecer com conteúdo
3. Link de download deve apontar para `storage.googleapis.com`

## Troubleshooting

### Erro: "Failed to initialize Google Cloud Storage"

**Causa:** Arquivo `gcs-credentials.json` não encontrado ou inválido

**Solução:**
1. Verifique se arquivo existe: `ls -la /home/linkiez/projetos/wa-webhook-router/gcs-credentials.json`
2. Verifique JSON válido: `cat gcs-credentials.json | jq .`
3. Verifique permissões: `chmod 644 gcs-credentials.json`

### Erro: "Permission denied" ao fazer upload

**Causa:** Service account sem permissões no bucket

**Solução:**
```bash
gcloud storage buckets add-iam-policy-binding \
  gs://chatwoot-whatsapp-media \
  --member="serviceAccount:wa-webhook-router@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### Erro: "Bucket not found"

**Causa:** Bucket não existe ou nome incorreto

**Solução:**
1. Verificar buckets existentes: `gcloud storage buckets list`
2. Criar bucket se necessário (veja passo 1)
3. Verificar variável `GCS_BUCKET` no `.env`

### Arquivos não ficam públicos

**Causa:** Bucket sem permissões públicas

**Solução:**
```bash
# Tornar todos objetos públicos
gsutil iam ch allUsers:objectViewer gs://chatwoot-whatsapp-media

# Verificar permissões
gsutil iam get gs://chatwoot-whatsapp-media
```

### URL não abre no navegador

**Causa:** Arquivo não público ou CORS bloqueado

**Solução:**
```bash
# Configurar CORS
cat > cors.json << EOF
[
  {
    "origin": ["*"],
    "method": ["GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
EOF

gsutil cors set cors.json gs://chatwoot-whatsapp-media
```

## Custos Estimados

### Google Cloud Storage Pricing (us-east1)

- **Armazenamento:** $0.020/GB/mês
- **Download (Class A):** $0.004 por 10.000 operações
- **Rede (saída):** $0.12/GB (para internet)

### Exemplo: 1000 documentos/mês

- Tamanho médio: 500 KB
- Armazenamento total: 0.5 GB
- Uploads: 1000 operações
- Downloads estimados: 2000 operações

**Custo mensal:** ~$0.10 + $0.40 + $0.80 (rede) = **~$1.30/mês**

## Segurança

### Boas Práticas

1. **Rotação de Chaves:**
   ```bash
   # A cada 90 dias, criar nova chave
   gcloud iam service-accounts keys create new-key.json \
     --iam-account=wa-webhook-router@PROJECT_ID.iam.gserviceaccount.com
   
   # Atualizar no servidor e restartar
   # Deletar chave antiga
   gcloud iam service-accounts keys delete KEY_ID \
     --iam-account=wa-webhook-router@PROJECT_ID.iam.gserviceaccount.com
   ```

2. **Lifecycle Policy (opcional):**
   ```bash
   # Deletar arquivos antigos automaticamente
   cat > lifecycle.json << EOF
   {
     "rule": [
       {
         "action": {"type": "Delete"},
         "condition": {"age": 90}
       }
     ]
   }
   EOF
   
   gsutil lifecycle set lifecycle.json gs://chatwoot-whatsapp-media
   ```

3. **Audit Logging:**
   - Habilitar Cloud Audit Logs no Console
   - Monitorar acessos suspeitos
