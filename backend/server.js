// Backend da Planta N1
// S7-1500 (PLCSIM Advanced) --OPC UA--> Node.js --Socket.IO--> Vue
//
// Baseado no roteiro do docente, com duas melhorias para a demonstração:
//   1) lê também o estado da máquina (requisito da somativa);
//   2) detecta a queda do OPC UA e reconecta sozinho, avisando o Vue.

const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds
} = require('node-opcua')

// ================== CONFIGURAÇÃO: AJUSTE AO SEU PROJETO ==================
// IP da instância no PLCSIM Advanced + porta do servidor OPC UA
const ENDPOINT = process.env.OPC_ENDPOINT || 'opc.tcp://169.254.171.199:4840'

// URI do namespace da server interface criada no TIA (interface "vue")
const URI_NAMESPACE = 'http://vue'

// Identificadores numéricos (i=...) de cada variável.
// Pegue no TIA: OPC UA communication > Server interfaces > vue >
// DB_Producao_N1 > selecione a variável > Properties > OPC UA attributes > Node ID
// Ex.: se o TIA mostrar "http://vue;i=3", o identificador é 3.
const IDS = {
  contPecasVermelhas: 3,
  contPecasVerdes: 4,
  contPecasAmarelas: 5,
  contPecasTotal: 6,
  estadoMaquina: 7
}

const PORTA_HTTP = 3000
const INTERVALO_LEITURA_MS = 500   // atualização dos valores
const ESPERA_RECONEXAO_MS = 3000   // pausa entre tentativas de reconexão
const TEMPO_LIMITE_MS = 3000       // tempo máximo de cada operação OPC UA
// ==========================================================================

const app = express()
app.use(cors())
const servidorHttp = http.createServer(app)
const io = new Server(servidorHttp, { cors: { origin: '*' } })

const opc = {
  conectado: false,
  mensagem: 'Aguardando comunicação com o S7-1500',
  ultimaLeitura: null
}
const dados = Object.fromEntries(Object.keys(IDS).map(nome => [nome, 0]))

let cliente = null
let sessao = null
let nos = []
let timerLeitura = null
let lendo = false
let reconectando = false
let tentativas = 0

function resumirErro (texto) {
  const msg = String(texto ?? 'erro desconhecido')
  if (/cannot be established|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|sem resposta/i.test(msg)) {
    return `o servidor OPC UA não respondeu em ${ENDPOINT}`
  }
  return msg.split('\n')[0]
}

// ---------- utilitários ----------
function comTempoLimite (promessa, ms) {
  promessa.catch(() => {}) // evita "unhandled rejection" se o tempo estourar antes
  let timer
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error(`sem resposta em ${ms} ms`)), ms)
  })
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer))
}

function definirStatus (conectado, mensagem) {
  const mudou = opc.conectado !== conectado || opc.mensagem !== mensagem
  opc.conectado = conectado
  opc.mensagem = mensagem
  if (!mudou) return
  console.log(`[OPC UA] ${conectado ? 'CONECTADO' : 'DESCONECTADO'} - ${mensagem}`)
  io.emit('opcStatus', opc.conectado) // mesmo evento do roteiro (true/false)
  io.emit('opcInfo', opc)             // detalhes para o card de comunicação
}

// ---------- ciclo de conexão ----------
async function conectar () {
  if (tentativas === 0) definirStatus(false, `Conectando a ${ENDPOINT}`)
  tentativas++
  try {
    cliente = OPCUAClient.create({
      applicationName: 'Backend Planta N1',
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      // a reconexão é feita por este programa (função falha), não pela biblioteca
      connectionStrategy: { initialDelay: 500, maxDelay: 1000, maxRetry: 0 }
    })
    cliente.on('connection_lost', () => falha('conexão com o S7-1500 perdida'))

    await comTempoLimite(cliente.connect(ENDPOINT), TEMPO_LIMITE_MS)
    sessao = await comTempoLimite(cliente.createSession(), TEMPO_LIMITE_MS)

    // Descobre o índice (ns=?) do namespace "http://vue" no servidor
    const resposta = await comTempoLimite(
      sessao.read({ nodeId: 'ns=0;i=2255', attributeId: AttributeIds.Value }),
      TEMPO_LIMITE_MS
    )
    const indice = resposta.value.value.indexOf(URI_NAMESPACE)
    if (indice < 0) {
      throw new Error(`namespace ${URI_NAMESPACE} não encontrado. Confira a server interface no TIA.`)
    }

    nos = Object.entries(IDS).map(([nome, id]) => ({
      nome,
      nodeId: `ns=${indice};i=${id}`,
      attributeId: AttributeIds.Value
    }))
    console.log('[OPC UA] NodeIds lidos:')
    nos.forEach(no => console.log(`   ${no.nome.padEnd(20)} ${no.nodeId}`))

    await ler()
    if (sessao) timerLeitura = setInterval(ler, INTERVALO_LEITURA_MS)
  } catch (erro) {
    await falha(erro.message)
  }
}

async function ler () {
  if (lendo || !sessao) return
  lendo = true
  try {
    const valores = await comTempoLimite(sessao.read(nos), TEMPO_LIMITE_MS)

    const ruim = valores.findIndex(v => !v.statusCode.isGood())
    if (ruim >= 0) {
      throw new Error(
        `leitura inválida em ${nos[ruim].nome} (${nos[ruim].nodeId}): ` +
        `${valores[ruim].statusCode.name}. Confira o identificador em IDS.`
      )
    }

    nos.forEach((no, i) => { dados[no.nome] = Number(valores[i].value.value ?? 0) })
    opc.ultimaLeitura = new Date().toISOString()
    tentativas = 0
    definirStatus(true, 'Comunicação com o S7-1500 ativa')
    io.emit('dadosProducao', { ...dados, ultimaLeitura: opc.ultimaLeitura })
  } catch (erro) {
    await falha(erro.message)
  } finally {
    lendo = false
  }
}

async function falha (motivo) {
  if (reconectando) return
  reconectando = true

  clearInterval(timerLeitura)
  timerLeitura = null
  definirStatus(false, `Sem comunicação: ${resumirErro(motivo)}. Tentando reconectar.`)

  const c = cliente
  const s = sessao
  cliente = null
  sessao = null
  try { if (s) await comTempoLimite(s.close(), 1000) } catch (_) {}
  try { if (c) await comTempoLimite(c.disconnect(), 1000) } catch (_) {}

  setTimeout(() => {
    reconectando = false
    conectar()
  }, ESPERA_RECONEXAO_MS)
}

// ---------- HTTP e Socket.IO ----------
app.get('/', (req, res) => res.json({
  backend: 'Funcionando',
  opcUa: opc.conectado ? 'Conectado' : 'Desconectado',
  mensagem: opc.mensagem,
  ultimaLeitura: opc.ultimaLeitura,
  producao: dados
}))

io.on('connection', socket => {
  socket.emit('opcStatus', opc.conectado)
  socket.emit('opcInfo', opc)
  socket.emit('dadosProducao', { ...dados, ultimaLeitura: opc.ultimaLeitura })
})

process.on('unhandledRejection', erro => console.log('[aviso]', erro?.message ?? erro))

servidorHttp.listen(PORTA_HTTP, () => {
  console.log(`Backend em http://localhost:${PORTA_HTTP}`)
  conectar()
})
