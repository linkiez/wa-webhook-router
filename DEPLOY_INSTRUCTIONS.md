# Deploy Instructions - WhatsApp Document Download Fix

## Problema Resolvido

O Chatwoot v4.10.0 **ignora documentos** enviados via WhatsApp (salva como `content: nil`). Este workaround intercepta webhooks, baixa documentos da WhatsApp Cloud API, e envia como anexo para o Chatwoot.

## Modificações Implementadas

### 1. Código Atualizado (`src/index.ts`)
- ✅ Detecta mensagens do tipo `document` nos webhooks
- ✅ Baixa o arquivo usando WhatsApp Cloud API (Graph API v18.0)
- ✅ Envia como `multipart/form-data` com anexo para o Chatwoot
- ✅ Fallback: se download falhar, envia webhook sem anexo

### 2. Dependências Adicionadas
```bash
npm install form-data
```

### 3. Configuração Necessária

#### a) Obter Token do WhatsApp
1. Acesse: https://developers.facebook.com/apps/
2. Selecione seu App WhatsApp Business
3. Navegue: **WhatsApp > API Settings** ou **WhatsApp > Getting Started**
4. Copie o **Access Token** (permanente, não temporário!)
5. Token deve ter permissões:
   - `whatsapp_business_messages`
   - `whatsapp_business_management`

#### b) Adicionar Token no `.env`
```env
WHATSAPP_API_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**⚠️ IMPORTANTE:**
- Use um **System User Token** (não expira)
- Ou configure renovação automática se usar **User Token** (expira em 60-90 dias)

## Deploy

### Opção 1: Rebuild e Restart (Recomendado)
```bash
cd /home/linkiez/projetos/wa-webhook-router

# Build nova imagem Docker
docker compose build

# Restart com novo código
docker compose down
docker compose up -d

# Verificar logs
docker compose logs -f
```

### Opção 2: Deploy sem Downtime
```bash
# Build
docker compose build

# Recreate apenas o container afetado
docker compose up -d --force-recreate wa-webhook-router

# Logs
docker compose logs -f wa-webhook-router
```

## Verificação

### 1. Testar Download de Documento
Envie um PDF pelo WhatsApp e verifique os logs:

```bash
docker compose logs -f wa-webhook-router | grep -i "document\|download\|media"
```

**Logs esperados:**
```
[SQS Consumer] Document detected: arquivo.pdf ID: 1234567890
[Media Download] Downloading from URL: https://lookaside.fbsbx.com/...
[Media Download] Successfully downloaded media, size: 52341 bytes
[SQS Consumer] Forwarding with document attachment: arquivo.pdf
[SQS Consumer] Successfully forwarded message
```

### 2. Verificar no Chatwoot
Após envio, o documento deve aparecer:
- ✅ Com conteúdo (não `nil`)
- ✅ Com nome do arquivo correto
- ✅ Download funcionando no chat

## Troubleshooting

### Erro: "WHATSAPP_API_TOKEN not configured"
**Causa:** Token não configurado no `.env`
**Solução:** Adicione `WHATSAPP_API_TOKEN` e faça rebuild

### Erro: "Media URL not found in response"
**Causa:** Token sem permissões ou expirado
**Solução:**
1. Verifique permissões do token
2. Gere novo token se necessário
3. Atualize `.env`

### Erro: 401/403 ao baixar mídia
**Causa:** Token inválido ou expirado
**Solução:**
1. Regenere token no Facebook Developer Console
2. Verifique se é System User Token (não expira)
3. Atualize `.env` e restart

### Documento ainda chega vazio no Chatwoot
**Causa:** Chatwoot pode não estar processando `multipart/form-data`
**Solução Alternativa:**
1. Modificar endpoint do Chatwoot para aceitar anexos
2. Ou usar API do Chatwoot para criar attachment separado

## Rollback

Se houver problemas, reverter para versão anterior:
```bash
cd /home/linkiez/projetos/wa-webhook-router
git checkout main
docker compose build
docker compose up -d --force-recreate
```

## Próximos Passos

1. **Testar em Produção**
   - Enviar PDF teste
   - Verificar logs
   - Confirmar recebimento no Chatwoot

2. **Monitorar**
   - Logs de erro de download
   - Taxa de sucesso
   - Performance (tempo de download)

3. **Melhorias Futuras**
   - Cache de downloads
   - Retry automático em falhas
   - Suporte para outros tipos de mídia (image, video, audio)
   - Compressão de arquivos grandes

## Notas Importantes

- ⚠️ URLs de mídia do WhatsApp **expiram em 5 minutos**
- ⚠️ Download deve ser **imediato** ao receber webhook
- ⚠️ Token do WhatsApp deve ter **permissões corretas**
- ✅ Solução funciona para **todos** os números configurados em `PHONE_ROUTES`
- ✅ Compatível com arquitetura SQS existente
