from flask import Flask, request, jsonify
import os
import re
import requests

app = Flask(__name__)

GOOGLE_SCRIPT_URL = os.environ.get("GOOGLE_SCRIPT_URL", "")
SEU_NUMERO = os.environ.get("SEU_NUMERO", "")

PRECO_BOMBOM = 5.00
PRECO_BOLO = 12.00


def get_nome(msg, prefixo):
    sem = msg.replace(prefixo, "").strip()
    partes = sem.split()
    nome = []
    for p in partes:
        if p.isdigit():
            break
        nome.append(p)
    return " ".join(nome)


def parse_produtos(texto):
    bombom = 0
    bolo = 0
    m1 = re.search(r"(\d+)\s*bombom", texto)
    m2 = re.search(r"(\d+)\s*bolo", texto)
    if m1:
        bombom = int(m1.group(1))
    if m2:
        bolo = int(m2.group(1))
    return bombom, bolo


def chamar_planilha(payload):
    if not GOOGLE_SCRIPT_URL:
        return "Configure GOOGLE_SCRIPT_URL nas variaveis de ambiente"
    try:
        r = requests.post(GOOGLE_SCRIPT_URL, json=payload, timeout=15)
        return r.json().get("reply", "Sem resposta da planilha")
    except Exception as e:
        return "Erro ao acessar planilha: " + str(e)


@app.route("/")
def home():
    return "Bot WhatsApp rodando com sucesso!"


@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.json or {}
    msg = (data.get("message", "") or "").lower().strip()

    if not msg:
        return jsonify({"ok": True})

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
        resposta = "Comandos disponíveis:\nadd Nome X bombom Y bolo\npag Nome X bombom\nver Nome\nrelatorio\ndel Nome\najuda"
    else:
        resposta = "Comando nao reconhecido. Digite ajuda"

    return jsonify({"reply": resposta, "ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
