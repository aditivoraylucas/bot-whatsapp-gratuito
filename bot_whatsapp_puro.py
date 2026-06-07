from flask import Flask, request
import os, re, requests

app = Flask(__name__)

GOOGLE_SCRIPT_URL = os.environ.get("GOOGLE_SCRIPT_URL", "")
SEU_NUMERO = os.environ.get("SEU_NUMERO", "")

PRECO_BOMBOM = 5.00
PRECO_BOLO = 12.00

def get_nome(msg, prefixo):
    sem = msg.replace(prefixo, "").strip()
    m = re.match(r"^([a-záãâêíóôõúç\s]+?)(?=\s*\d|$)", sem, re.I)
    return m.group(1).strip() if m else sem.split()[0]

def parse_produtos(texto):
    bombom = 0
    bolo = 0
    m1 = re.search(r"(\d+)\s*bombom", texto)
    m2 = re.search(r"(\d+)\s*bolo", texto)
    if m1: bombom = int(m1.group(1))
    if m2: bolo = int(m2.group(1))
    return bombom, bolo

def chamar_planilha(payload):
    if not GOOGLE_SCRIPT_URL:
        return "Configure GOOGLE_SCRIPT_URL"
    r = requests.post(GOOGLE_SCRIPT_URL, json=payload, timeout=15)
    return r.json().get("reply", "Sem resposta")

@app.route("/")
def home():
    return "Bot WhatsApp rodando"

@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.json or {}
    msg = (data.get("message", "") or "").lower().strip()
    if not msg:
        return {"ok": True}

    if msg.startswith("add "):
        nome = get_nome(msg, "add ")
        b, bo = parse_produtos(msg)
        resposta = chamar_planilha({"acao": "add", "nome": nome, "bombom": b, "bolo": bo})
    elif msg.startswith("pag "):
        nome = get_nome(msg, "pag ")
        b, bo = parse_produtos(msg)
        resposta = chamar_planilha({"acao": "pag", "nome": nome, "bombom": b, "bolo": bo})
    elif msg.startswith("ver "):
        nome = msg.replace("ver ", "").strip()
        resposta = chamar_planilha({"acao": "ver", "nome": nome})
    elif msg == "relatorio":
        resposta = chamar_planilha({"acao": "relatorio"})
    elif msg.startswith("del "):
        nome = msg.replace("del ", "").strip()
        resposta = chamar_planilha({"acao": "del", "nome": nome})
    elif msg == "ajuda":
        resposta = "Comandos: add / pag / ver / relatorio / del / ajuda"
    else:
        resposta = "Comando nao reconhecido. Digite ajuda"

    return {"reply": resposta, "ok": True}

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
