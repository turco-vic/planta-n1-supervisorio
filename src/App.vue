<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { io } from 'socket.io-client'

// Endereço do backend Node.js (pode ser trocado em um arquivo .env: VITE_BACKEND_URL=...)
const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
const socket = io(BACKEND, { autoConnect: false })

const WATCHDOG_MS = 5000 // sem leitura nova por mais que isso = "Leitura parada"

const ESTADOS = {
  0: { nome: 'Inicialização e recuo', acao: 'Recuando cilindros e inicializando' },
  1: { nome: 'Pronto para iniciar', acao: 'Aguardando início do ciclo' },
  2: { nome: 'Transporte e identificação', acao: 'Peça em transporte até o sensor de cor' },
  3: { nome: 'Separação amarela', acao: 'Desviando peça para a baia amarela' },
  4: { nome: 'Separação vermelha', acao: 'Desviando peça para a baia vermelha' },
  5: { nome: 'Separação verde', acao: 'Desviando peça para a baia verde' }
}

/* ---------------- Dados recebidos ---------------- */
const backendOnline = ref(false)
const opcConectado = ref(false)
const opcMensagem = ref('Aguardando comunicação com o S7-1500')
const ultimaLeitura = ref(null)
const cont = reactive({ total: 0, vermelha: 0, verde: 0, amarela: 0 })
const estado = ref(0)
const agora = ref(Date.now())
const simulando = ref(false)
let ultimosDadosReais = null

/* ---------------- Indicadores ---------------- */
const indicadores = computed(() => [
  { chave: 'total', titulo: 'Produção total', legenda: 'Total de peças processadas', cor: 'var(--azul)' },
  { chave: 'vermelha', titulo: 'Peças vermelhas', legenda: 'Total destinado à baia vermelha', cor: 'var(--vermelho)' },
  { chave: 'verde', titulo: 'Peças verdes', legenda: 'Total destinado à baia verde', cor: 'var(--verde)' },
  { chave: 'amarela', titulo: 'Peças amarelas', legenda: 'Total destinado à baia amarela', cor: 'var(--amarelo)' }
].map(i => {
  const fracao = i.chave === 'total' ? 1 : (cont.total ? cont[i.chave] / cont.total : 0)
  return { ...i, valor: cont[i.chave], porcentagem: Math.round(fracao * 100), fracao }
}))

const RAIO = 52
const CIRCUNFERENCIA = 2 * Math.PI * RAIO

/* ---------------- Estado e comunicação ---------------- */
const estadoAtual = computed(() => ESTADOS[estado.value] || { nome: 'Estado não previsto', acao: 'Verifique o programa do CLP' })

const idadeLeitura = computed(() => (ultimaLeitura.value ? agora.value - ultimaLeitura.value : null))
const leituraParada = computed(() =>
  !simulando.value && backendOnline.value && opcConectado.value &&
  idadeLeitura.value !== null && idadeLeitura.value > WATCHDOG_MS
)

const status = computed(() => {
  if (simulando.value) return { tipo: 'aviso', texto: 'Simulação' }
  if (!backendOnline.value) return { tipo: 'alarme', texto: 'Backend offline' }
  if (!opcConectado.value) return { tipo: 'alarme', texto: 'CLP desconectado' }
  if (leituraParada.value) return { tipo: 'aviso', texto: 'Leitura parada' }
  return { tipo: 'ok', texto: 'CLP conectado' }
})

const mensagemComunicacao = computed(() => {
  if (simulando.value) return 'Simulação ligada: os valores exibidos são fictícios'
  if (!backendOnline.value) return `Backend sem resposta em ${BACKEND}`
  if (leituraParada.value) return `Sem leitura nova do S7-1500 há mais de ${WATCHDOG_MS / 1000} s`
  return opcMensagem.value
})

const textoUltimaLeitura = computed(() => {
  if (idadeLeitura.value === null) return 'ainda não recebida'
  const s = Math.max(0, idadeLeitura.value) / 1000
  if (s > 60) return `às ${new Date(ultimaLeitura.value).toLocaleTimeString('pt-BR')}`
  return `há ${s.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
})

/* ---------------- Simulação ---------------- */
let timerSimulacao = null
const CORES_SIM = [{ chave: 'amarela', estado: 3 }, { chave: 'vermelha', estado: 4 }, { chave: 'verde', estado: 5 }]

function passoSimulacao (e) {
  estado.value = e
  ultimaLeitura.value = Date.now()
  if (e === 0 || e === 1) {
    timerSimulacao = setTimeout(() => passoSimulacao(e + 1), 1500)
  } else if (e === 2) {
    const cor = CORES_SIM[Math.floor(Math.random() * CORES_SIM.length)]
    timerSimulacao = setTimeout(() => passoSimulacao(cor.estado), 2500)
  } else {
    const cor = CORES_SIM.find(c => c.estado === e)
    timerSimulacao = setTimeout(() => {
      cont[cor.chave]++
      cont.total++
      passoSimulacao(2)
    }, 2000)
  }
}

function alternarSimulacao () {
  clearTimeout(timerSimulacao)
  simulando.value = !simulando.value
  if (simulando.value) {
    Object.assign(cont, { total: 0, vermelha: 0, verde: 0, amarela: 0 })
    passoSimulacao(0)
  } else if (ultimosDadosReais) {
    aplicarDados(ultimosDadosReais)
  }
}

/* ---------------- Socket.IO ---------------- */
function aplicarDados (d) {
  cont.total = Number(d.contPecasTotal ?? 0)
  cont.vermelha = Number(d.contPecasVermelhas ?? 0)
  cont.verde = Number(d.contPecasVerdes ?? 0)
  cont.amarela = Number(d.contPecasAmarelas ?? 0)
  estado.value = Number(d.estadoMaquina ?? 0)
  ultimaLeitura.value = d.ultimaLeitura ? new Date(d.ultimaLeitura).getTime() : Date.now()
}
function aoReceberDados (d) {
  ultimosDadosReais = d
  if (!simulando.value) aplicarDados(d)
}
function aoReceberStatus (s) { opcConectado.value = Boolean(s) }
function aoReceberInfo (info) {
  opcConectado.value = Boolean(info.conectado)
  if (info.mensagem) opcMensagem.value = info.mensagem
}
function aoConectar () { backendOnline.value = true }
function aoDesconectar () { backendOnline.value = false; opcConectado.value = false }

let relogio = null

onMounted(() => {
  socket.on('connect', aoConectar)
  socket.on('disconnect', aoDesconectar)
  socket.on('connect_error', aoDesconectar)
  socket.on('opcStatus', aoReceberStatus)
  socket.on('opcInfo', aoReceberInfo)
  socket.on('dadosProducao', aoReceberDados)
  socket.connect()
  relogio = setInterval(() => { agora.value = Date.now() }, 500)
})

onUnmounted(() => {
  socket.off()
  socket.disconnect()
  clearInterval(relogio)
  clearTimeout(timerSimulacao)
})
</script>

<template>
  <div class="pagina">
    <header class="topo">
      <div>
        <h1>Interface Gráfica da Planta N1</h1>
        <p>Seleção e movimentação de peças por cor</p>
      </div>
      <div class="topo__acoes">
        <button class="botao-sim" :class="{ ativo: simulando }" @click="alternarSimulacao">
          {{ simulando ? 'Parar simulação' : 'Simular' }}
        </button>
        <span class="selo" :class="`selo--${status.tipo}`">
          <span class="selo__ponto"></span>{{ status.texto }}
        </span>
      </div>
    </header>

    <main class="conteudo">
      <section class="card">
        <h2>Indicadores de produção</h2>
        <div class="indicadores">
          <div v-for="i in indicadores" :key="i.chave" class="indicador">
            <svg class="anel" viewBox="0 0 120 120" role="img" :aria-label="`${i.titulo}: ${i.valor}`">
              <circle cx="60" cy="60" :r="RAIO" class="anel__fundo" />
              <circle
                cx="60" cy="60" :r="RAIO" class="anel__valor"
                :style="{ stroke: i.cor, strokeDasharray: CIRCUNFERENCIA, strokeDashoffset: CIRCUNFERENCIA * (1 - i.fracao) }"
              />
              <text x="60" y="60" class="anel__numero">{{ i.valor }}</text>
            </svg>
            <strong>{{ i.titulo }}</strong>
            <span class="indicador__porcentagem" v-if="i.chave !== 'total'">{{ i.porcentagem }}% da produção</span>
            <small>{{ i.legenda }}</small>
          </div>
        </div>
      </section>

      <div class="linha">
        <section class="card">
          <h2>Estado da aplicação</h2>
          <div class="estado">
            <span class="estado__numero">{{ estado }}</span>
            <span class="estado__nome">{{ estadoAtual.nome }}</span>
          </div>
          <p class="texto">{{ estadoAtual.acao }}</p>
        </section>

        <section class="card">
          <h2>Comunicação OPC UA</h2>
          <p class="texto">{{ mensagemComunicacao }}</p>
          <p class="texto texto--suave">Última leitura: {{ textoUltimaLeitura }}</p>
        </section>
      </div>
    </main>
  </div>
</template>

<style>
:root {
  --fundo: #eef1f4;
  --card: #ffffff;
  --borda: #dde2e7;
  --texto: #1f2a36;
  --texto-suave: #6b7682;
  --cabecalho: #1e3246;
  --azul: #1a8fa8;
  --vermelho: #c62828;
  --verde: #2e7d32;
  --amarelo: #f2a52b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--fundo);
  color: var(--texto);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
}
</style>

<style scoped>
.topo {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 18px 24px;
  background: var(--cabecalho);
  color: #fff;
  border-bottom: 4px solid #2bb3a0;
}
.topo h1 { margin: 0; font-size: 1.6rem; font-weight: 500; }
.topo p { margin: 6px 0 0; font-size: 0.85rem; opacity: 0.85; }
.topo__acoes { display: flex; align-items: center; gap: 10px; }

.selo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 0.85rem;
}
.selo__ponto { width: 8px; height: 8px; border-radius: 50%; background: #fff; }
.selo--ok { background: var(--verde); }
.selo--alarme { background: var(--vermelho); }
.selo--aviso { background: #d98a00; }

.botao-sim {
  padding: 7px 12px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 4px;
  background: transparent;
  color: #fff;
  font-size: 0.8rem;
  cursor: pointer;
}
.botao-sim:hover, .botao-sim.ativo { background: rgba(255, 255, 255, 0.15); }

.conteudo {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px 16px;
  display: grid;
  gap: 16px;
}
.card {
  background: var(--card);
  border: 1px solid var(--borda);
  border-radius: 6px;
  padding: 18px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.card h2 { margin: 0 0 16px; font-size: 1.15rem; font-weight: 500; }

.indicadores {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
}
.indicador {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  text-align: center;
  background: #f7f9fa;
  border: 1px solid var(--borda);
  border-radius: 6px;
}
.indicador strong { font-size: 0.9rem; margin-top: 4px; }
.indicador small { font-size: 0.72rem; color: var(--texto-suave); }
.indicador__porcentagem { font-size: 0.8rem; font-weight: 600; color: var(--texto-suave); }

.anel { width: 100px; height: 100px; }
.anel__fundo { fill: #fff; stroke: #e3e7eb; stroke-width: 12; }
.anel__valor {
  fill: none;
  stroke-width: 12;
  stroke-linecap: butt;
  transform: rotate(-90deg);
  transform-origin: 60px 60px;
  transition: stroke-dashoffset 0.6s ease;
}
.anel__numero {
  font-size: 30px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
  fill: var(--texto);
}

.linha {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
.estado { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.estado__numero { font-size: 2.4rem; font-weight: 700; color: var(--verde); }
.estado__nome { font-size: 1.05rem; font-weight: 600; }
.texto { margin: 10px 0 0; font-size: 0.9rem; }
.texto--suave { color: var(--texto-suave); font-size: 0.8rem; }
</style>
