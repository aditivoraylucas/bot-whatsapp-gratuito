# 🤖 Bot WhatsApp - Controle de Vendas

Bot 100% gratuito para registrar vendas de **Bombom/Trufa** e **Bolo/Bolo de Pote** via WhatsApp.

## ✨ Funcionalidades
- ✅ Responde mensagens de texto e **áudios** (até 5 segundos)
- ✅ Funciona em **grupo do WhatsApp**
- ✅ Registra automaticamente na **Google Sheets**
- ✅ Calcula o total em R$
- ✅ Roda 100% gratuito no **Render**

## 💬 Como usar no grupo

Mande uma mensagem ou áudio:
```
vendi 3 trufa e 2 bolo
```

O bot responde:
```
✅ Anotado, Maria!
🍫 Bombom/Trufa: 3 unid. = R$ 15,00
🎂 Bolo/Bolo de Pote: 2 unid. = R$ 24,00
💰 Total: R$ 39,00
```

## 🛠️ Configuração

### Variáveis de ambiente no Render
| Variável | Descrição |
|---|---|
| `GRUPO_NOME` | Parte do nome do grupo WhatsApp (ex: `vendas`) |
| `SPREADSHEET_ID` | ID da planilha Google Sheets |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Email da conta de serviço Google |
| `GOOGLE_PRIVATE_KEY` | Chave privada da conta de serviço |

### Produtos e preços
- 🍫 **Bombom/Trufa**: R$ 5,00
- 🎂 **Bolo/Bolo de Pote**: R$ 12,00

### Apelidos aceitos
- Trufa: `trufa`, `trufas`, `trufinha`, `bombom`, `bombons`
- Bolo: `bolo`, `bolinho`, `bolo de pote`, `bolo pote`
