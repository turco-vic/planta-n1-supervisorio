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
          <div v-for="i in indicadores" :key="i.chave" class="indicador" :style="{ '--cor': i.cor }">
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
            <span class="indicador__porcentagem" v-else>todas as cores</span>
            <small>{{ i.legenda }}</small>
          </div>
        </div>
      </section>

      <div class="linha">
        <section class="card">
          <h2>Estado da aplicação</h2>
          <div class="estado">
            <span class="estado__numero">{{ estado }}</span>
            <div>
              <span class="estado__nome">{{ estadoAtual.nome }}</span>
              <p class="estado__acao">{{ estadoAtual.acao }}</p>
            </div>
          </div>
          <div class="etapas" aria-hidden="true">
            <span
              v-for="(_, id) in ESTADOS" :key="id"
              class="etapas__item" :class="{ 'etapas__item--ativo': Number(id) === estado }"
            >{{ id }}</span>
          </div>
        </section>

        <section class="card">
          <h2>Comunicação OPC UA</h2>
          <div class="com" :class="`com--${status.tipo}`">
            <span class="com__ponto"></span>
            <span>{{ mensagemComunicacao }}</span>
          </div>
          <dl class="detalhes">
            <div><dt>Situação</dt><dd>{{ status.texto }}</dd></div>
            <div><dt>Última leitura</dt><dd>{{ textoUltimaLeitura }}</dd></div>
            <div><dt>Backend</dt><dd>{{ BACKEND }}</dd></div>
          </dl>
        </section>
      </div>
    </main>
  </div>
</template>

<style>
:root {
  --fundo: #f1f4f8;
  --card: #ffffff;
  --borda: #e3e8ef;
  --texto: #1b2735;
  --texto-suave: #6b7787;
  --cabecalho-1: #14273a;
  --cabecalho-2: #1f3d57;
  --destaque: #2bb3a0;
  --azul: #1a93ad;
  --vermelho: #d6373a;
  --verde: #2f9447;
  --amarelo: #f0a623;
  --sombra: 0 1px 2px rgba(16, 32, 52, 0.05), 0 8px 24px rgba(16, 32, 52, 0.06);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--fundo);
  color: var(--texto);
  font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
</style>

<style scoped>
/* ---------- Cabeçalho ---------- */
.topo {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 22px max(16px, calc((100% - 1100px) / 2 + 16px));
  background: linear-gradient(120deg, var(--cabecalho-1), var(--cabecalho-2));
  color: #fff;
  box-shadow: inset 0 -4px 0 var(--destaque);
}
.topo h1 { margin: 0; font-size: 1.6rem; font-weight: 600; letter-spacing: -0.01em; }
.topo p { margin: 6px 0 0; font-size: 0.88rem; color: rgba(255, 255, 255, 0.72); }
.topo__acoes { display: flex; align-items: center; gap: 10px; }

.selo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 0.85rem;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
}
.selo__ponto {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fff;
  animation: pulsar 1.6s ease-out infinite;
}
.selo--ok { background: var(--verde); }
.selo--alarme { background: var(--vermelho); }
.selo--aviso { background: #d98a00; }

@keyframes pulsar {
  0% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.7); }
  100% { box-shadow: 0 0 0 8px rgba(255, 255, 255, 0); }
}

.botao-sim {
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}
.botao-sim:hover { background: rgba(255, 255, 255, 0.16); }
.botao-sim.ativo { background: #fff; color: var(--cabecalho-1); border-color: #fff; font-weight: 600; }

/* ---------- Estrutura ---------- */
.conteudo {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 16px 32px;
  display: grid;
  gap: 18px;
}
.card {
  background: var(--card);
  border: 1px solid var(--borda);
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: var(--sombra);
}
.card h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 18px;
  font-size: 1.1rem;
  font-weight: 600;
}
.card h2::before {
  content: '';
  width: 4px;
  height: 18px;
  border-radius: 2px;
  background: var(--destaque);
}

/* ---------- Indicadores ---------- */
.indicadores {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 16px;
}
.indicador {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 20px 12px 16px;
  text-align: center;
  background: linear-gradient(180deg, color-mix(in srgb, var(--cor) 7%, #fff), #fff 60%);
  border: 1px solid var(--borda);
  border-radius: 12px;
  overflow: hidden;
  transition: transform 0.2s, box-shadow 0.2s;
}
.indicador::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 4px;
  background: var(--cor);
}
.indicador:hover { transform: translateY(-2px); box-shadow: var(--sombra); }
.indicador strong { font-size: 0.95rem; margin-top: 8px; }
.indicador small { font-size: 0.74rem; color: var(--texto-suave); }
.indicador__porcentagem {
  margin: 2px 0;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--cor) 80%, #000);
  background: color-mix(in srgb, var(--cor) 14%, #fff);
}

.anel { width: 116px; height: 116px; }
.anel__fundo {
  fill: #fff;
  stroke: color-mix(in srgb, var(--cor) 16%, #fff);
  stroke-width: 11;
}
.anel__valor {
  fill: none;
  stroke-width: 11;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 60px 60px;
  transition: stroke-dashoffset 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}
.anel__numero {
  font-size: 32px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
  fill: var(--texto);
}

/* ---------- Estado e comunicação ---------- */
.linha {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 18px;
}
.estado { display: flex; align-items: center; gap: 16px; }
.estado__numero {
  flex: none;
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 14px;
  font-size: 2rem;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, var(--verde), #3fb35c);
  box-shadow: 0 6px 16px rgba(47, 148, 71, 0.3);
}
.estado__nome { font-size: 1.1rem; font-weight: 600; }
.estado__acao { margin: 4px 0 0; font-size: 0.88rem; color: var(--texto-suave); }

.etapas { display: flex; gap: 6px; margin-top: 18px; }
.etapas__item {
  flex: 1;
  padding: 5px 0;
  border-radius: 6px;
  text-align: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--texto-suave);
  background: #eef1f5;
  transition: background 0.3s, color 0.3s;
}
.etapas__item--ativo { background: var(--verde); color: #fff; }

.com {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 500;
}
.com__ponto { flex: none; width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.com--ok { background: color-mix(in srgb, var(--verde) 10%, #fff); color: #23703a; }
.com--alarme { background: color-mix(in srgb, var(--vermelho) 9%, #fff); color: #a8282b; }
.com--aviso { background: #fff5e0; color: #9a6200; }

.detalhes { margin: 14px 0 0; display: grid; gap: 8px; }
.detalhes div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--borda);
  font-size: 0.84rem;
}
.detalhes div:last-child { border-bottom: none; padding-bottom: 0; }
.detalhes dt { color: var(--texto-suave); }
.detalhes dd { margin: 0; font-weight: 600; text-align: right; overflow-wrap: anywhere; }

@media (max-width: 480px) {
  .topo h1 { font-size: 1.3rem; }
  .card { padding: 16px; }
}
</style>
