<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { io } from 'socket.io-client'

// Endereço do backend Node.js (pode ser trocado em um arquivo .env: VITE_BACKEND_URL=...)
const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
const socket = io(BACKEND, { autoConnect: false })

/* ------------------------------------------------------------------
   Ajustes gerais
------------------------------------------------------------------- */
const WATCHDOG_MS = 5000          // sem leitura nova por mais que isso = alarme
const AMOSTRA_MS = 5000           // intervalo entre amostras do gráfico
const PONTOS_TENDENCIA = 120      // 120 x 5 s = 10 minutos
const MAX_EVENTOS = 200
const CARENCIA_INICIAL_MS = 3000  // tempo para o socket conectar antes de acusar alarme

const ESTADOS = [
  { id: 0, nome: 'Inicialização e recuo' },
  { id: 1, nome: 'Pronto para iniciar' },
  { id: 2, nome: 'Transporte e identificação' },
  { id: 3, nome: 'Separação amarela', ramo: true },
  { id: 4, nome: 'Separação vermelha', ramo: true },
  { id: 5, nome: 'Separação verde', ramo: true }
]

// Ordem e posição das baias no desenho (ajuste para a ordem real da bancada)
const BAIAS = [
  { chave: 'amarela', nome: 'Amarela', estado: 3, x: 360 },
  { chave: 'vermelha', nome: 'Vermelha', estado: 4, x: 500 },
  { chave: 'verde', nome: 'Verde', estado: 5, x: 640 }
]

// Geometria do sinótico (viewBox 800 x 290)
const X_INICIO = 80
const X_SENSOR = 200
const Y_ESTEIRA = 120
const Y_BAIA = 208
const CURSO_CILINDRO = 50

/* ------------------------------------------------------------------
   Estado da comunicação e dados do CLP
------------------------------------------------------------------- */
const backendOnline = ref(false)
const opcConectado = ref(false)
const opcMensagem = ref('Aguardando comunicação com o S7-1500')
const ultimaLeitura = ref(null)
const cont = reactive({ vermelha: 0, verde: 0, amarela: 0, total: 0 })
const estado = ref(0)
const simulando = ref(false)
const pronto = ref(false)
const agora = ref(Date.now())

let ultimosDadosReais = null
let jaSincronizado = false

const idadeLeitura = computed(() => (ultimaLeitura.value ? agora.value - ultimaLeitura.value : null))
const dadoCongelado = computed(() =>
  !simulando.value && backendOnline.value && opcConectado.value &&
  idadeLeitura.value !== null && idadeLeitura.value > WATCHDOG_MS
)
const comunicacaoOk = computed(() =>
  simulando.value || (backendOnline.value && opcConectado.value && !dadoCongelado.value)
)
const estadoInvalido = computed(() => !ESTADOS.some(e => e.id === estado.value))
const somaConfere = computed(() => cont.total === cont.vermelha + cont.verde + cont.amarela)

const status = computed(() => {
  if (simulando.value) return { tipo: 'aviso', texto: 'Simulação' }
  if (!backendOnline.value) return { tipo: 'alarme', texto: 'Backend offline' }
  if (!opcConectado.value) return { tipo: 'alarme', texto: 'CLP desconectado' }
  if (dadoCongelado.value) return { tipo: 'aviso', texto: 'Leitura parada' }
  return { tipo: 'ok', texto: 'CLP conectado' }
})

const textoIdade = computed(() => {
  if (idadeLeitura.value === null) return 'ainda não recebida'
  if (idadeLeitura.value > 60000) return `às ${fmtHora(ultimaLeitura.value)}`
  return `há ${fmt1(Math.max(0, idadeLeitura.value) / 1000)} s`
})

/* ------------------------------------------------------------------
   Formatação
------------------------------------------------------------------- */
function fmt1 (n) {
  if (n === null || n === undefined || !isFinite(n)) return '–'
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
function fmtDuracao (ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return '–'
  const s = ms / 1000
  if (s < 60) return `${fmt1(s)} s`
  return `${Math.floor(s / 60)} min ${Math.floor(s % 60)} s`
}
function fmtHora (t) { return new Date(t).toLocaleTimeString('pt-BR') }
function porcentagem (parte) {
  return cont.total ? Math.round((parte / cont.total) * 100) : 0
}

/* ------------------------------------------------------------------
   Eventos e alarmes
------------------------------------------------------------------- */
const ROTULO_TIPO = { alarme: 'Alarme', aviso: 'Aviso', info: 'Info', normal: 'Normalizado' }
const eventos = ref([])
const somenteAlarmes = ref(false)
let idEvento = 0

function registrar (tipo, texto) {
  eventos.value = [{ id: ++idEvento, hora: Date.now(), tipo, texto }, ...eventos.value].slice(0, MAX_EVENTOS)
}

const eventosVisiveis = computed(() =>
  somenteAlarmes.value ? eventos.value.filter(e => e.tipo === 'alarme' || e.tipo === 'normal') : eventos.value
)

const alarmesAtivos = computed(() => {
  if (!pronto.value) return []
  const lista = []
  if (!simulando.value) {
    if (!backendOnline.value) lista.push(`Backend sem resposta em ${BACKEND}. Inicie com "node server.js".`)
    else if (!opcConectado.value) lista.push(opcMensagem.value || 'OPC UA desconectado do S7-1500')
    else if (dadoCongelado.value) lista.push(`Sem leitura nova do S7-1500 há mais de ${WATCHDOG_MS / 1000} s`)
  }
  if (estadoInvalido.value) lista.push(`Estado ${estado.value} recebido do CLP não está previsto`)
  if (!somaConfere.value) lista.push('Soma das cores não confere com a produção total')
  return lista
})

watch(alarmesAtivos, (novos, antigos = []) => {
  novos.filter(a => !antigos.includes(a)).forEach(a => registrar('alarme', a))
  antigos.filter(a => !novos.includes(a)).forEach(a => registrar('normal', a))
})

function exportarCsv () {
  const linhas = [
    ['Data', 'Hora', 'Tipo', 'Descrição'],
    ...eventos.value.slice().reverse().map(e => [
      new Date(e.hora).toLocaleDateString('pt-BR'), fmtHora(e.hora), ROTULO_TIPO[e.tipo], e.texto
    ])
  ]
  const csv = '\uFEFF' + linhas
    .map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `eventos-planta-n1-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/* ------------------------------------------------------------------
   Contadores, ciclos e taxa
------------------------------------------------------------------- */
const marcasPeca = ref([]) // instantes em que a produção total incrementou

function definirContadores (novos) {
  if (!jaSincronizado) {
    Object.assign(cont, novos)
    jaSincronizado = true
    return
  }
  BAIAS.forEach(b => {
    if (novos[b.chave] > cont[b.chave]) registrar('info', `Peça ${b.nome.toLowerCase()} separada`)
  })
  if (novos.total > cont.total) {
    marcasPeca.value = [...marcasPeca.value, Date.now()].slice(-50)
  } else if (novos.total < cont.total) {
    marcasPeca.value = []
    registrar('info', 'Contadores zerados no CLP')
  }
  Object.assign(cont, novos)
}

const pecasUltimoMinuto = computed(() => marcasPeca.value.filter(t => agora.value - t <= 60000).length)
const ultimoCiclo = computed(() => {
  const m = marcasPeca.value
  return m.length >= 2 ? m[m.length - 1] - m[m.length - 2] : null
})
const cicloMedio = computed(() => {
  const m = marcasPeca.value.slice(-11)
  return m.length >= 2 ? (m[m.length - 1] - m[0]) / (m.length - 1) : null
})

/* ------------------------------------------------------------------
   Tempo no estado atual
------------------------------------------------------------------- */
const inicioEstado = ref(Date.now())
const tempoNoEstado = computed(() => agora.value - inicioEstado.value)

/* ------------------------------------------------------------------
   Gráfico de tendência
------------------------------------------------------------------- */
const amostras = ref([])
function amostrar () {
  amostras.value = [...amostras.value, { t: Date.now(), ...cont }].slice(-PONTOS_TENDENCIA)
}

const LARGURA_G = 600
const ALTURA_G = 160
const grafico = computed(() => {
  const am = amostras.value
  const base = am[0] || { total: 0, vermelha: 0, verde: 0, amarela: 0 }
  const rel = (a, chave) => Math.max(0, a[chave] - base[chave])
  const max = Math.max(5, ...am.map(a => rel(a, 'total')))
  const passo = LARGURA_G / (PONTOS_TENDENCIA - 1)
  const deslocamento = PONTOS_TENDENCIA - am.length
  const pontos = chave => am
    .map((a, i) => `${((deslocamento + i) * passo).toFixed(1)},${(ALTURA_G - (rel(a, chave) / max) * ALTURA_G).toFixed(1)}`)
    .join(' ')
  return {
    max,
    series: [
      { chave: 'total', nome: 'Total', pontos: pontos('total') },
      ...BAIAS.map(b => ({ chave: b.chave, nome: b.nome, pontos: pontos(b.chave) }))
    ]
  }
})

/* ------------------------------------------------------------------
   Sinótico animado
------------------------------------------------------------------- */
const peca = reactive({ x: X_INICIO, y: Y_ESTEIRA, cor: null, visivel: false, duracao: 0 })
const cilindroAtivo = ref(null)
let timersSinotico = []

const estiloPeca = computed(() => ({
  transform: `translate(${peca.x}px, ${peca.y}px)`,
  opacity: peca.visivel ? 1 : 0,
  transition: peca.duracao
    ? `transform ${peca.duracao}ms ease-in-out, opacity 250ms`
    : 'opacity 250ms'
}))

const esteiraMovendo = computed(() =>
  comunicacaoOk.value && estado.value >= 2 && estado.value <= 5 && !cilindroAtivo.value
)

const acaoAtual = computed(() => {
  const e = estado.value
  if (e === 0) return 'Recuando cilindros e inicializando'
  if (e === 1) return 'Aguardando início do ciclo'
  if (e === 2) return 'Peça em transporte até o sensor de cor'
  const baia = BAIAS.find(b => b.estado === e)
  if (baia) return `Desviando peça para a baia ${baia.nome.toLowerCase()}`
  return 'Estado não previsto'
})

function depois (ms, fn) { timersSinotico.push(setTimeout(fn, ms)) }
function limparSinotico () { timersSinotico.forEach(clearTimeout); timersSinotico = [] }
function proximoQuadro (fn) { requestAnimationFrame(() => requestAnimationFrame(fn)) }

async function animarSinotico (e) {
  limparSinotico()

  if (e === 2) {
    cilindroAtivo.value = null
    Object.assign(peca, { duracao: 0, x: X_INICIO, y: Y_ESTEIRA, cor: null, visivel: true })
    await nextTick()
    proximoQuadro(() => Object.assign(peca, { duracao: 2200, x: X_SENSOR }))
    return
  }

  const baia = BAIAS.find(b => b.estado === e)
  if (baia) {
    if (!peca.visivel) Object.assign(peca, { duracao: 0, x: X_SENSOR, y: Y_ESTEIRA, visivel: true })
    peca.cor = baia.chave
    await nextTick()
    proximoQuadro(() => Object.assign(peca, { duracao: 1200, x: baia.x }))
    depois(1300, () => {
      cilindroAtivo.value = baia.chave
      Object.assign(peca, { duracao: 450, y: Y_BAIA })
    })
    depois(2000, () => { cilindroAtivo.value = null })
    depois(2600, () => { peca.visivel = false })
    return
  }

  cilindroAtivo.value = null
  peca.visivel = false
}

watch(estado, (novo) => {
  inicioEstado.value = Date.now()
  animarSinotico(novo)
})

/* ------------------------------------------------------------------
   Modo simulação (para testar e apresentar sem a bancada)
------------------------------------------------------------------- */
let timerSimulacao = null

function passoSimulacao (e) {
  estado.value = e
  ultimaLeitura.value = Date.now()
  if (e === 0) { timerSimulacao = setTimeout(() => passoSimulacao(1), 1500); return }
  if (e === 1) { timerSimulacao = setTimeout(() => passoSimulacao(2), 1500); return }
  if (e === 2) {
    const sorteada = BAIAS[Math.floor(Math.random() * BAIAS.length)]
    timerSimulacao = setTimeout(() => passoSimulacao(sorteada.estado), 2600)
    return
  }
  const baia = BAIAS.find(b => b.estado === e)
  timerSimulacao = setTimeout(() => {
    definirContadores({ ...cont, [baia.chave]: cont[baia.chave] + 1, total: cont.total + 1 })
    passoSimulacao(2)
  }, 2200)
}

function alternarSimulacao () {
  if (simulando.value) {
    clearTimeout(timerSimulacao)
    simulando.value = false
    registrar('info', 'Simulação desligada')
    if (ultimosDadosReais) aplicarDados(ultimosDadosReais)
  } else {
    simulando.value = true
    registrar('aviso', 'Simulação ligada: os valores exibidos são fictícios')
    passoSimulacao(0)
  }
}

/* ------------------------------------------------------------------
   Socket.IO
------------------------------------------------------------------- */
function aplicarDados (dados) {
  definirContadores({
    vermelha: Number(dados.contPecasVermelhas ?? 0),
    verde: Number(dados.contPecasVerdes ?? 0),
    amarela: Number(dados.contPecasAmarelas ?? 0),
    total: Number(dados.contPecasTotal ?? 0)
  })
  estado.value = Number(dados.estadoMaquina ?? 0)
  ultimaLeitura.value = dados.ultimaLeitura ? new Date(dados.ultimaLeitura).getTime() : Date.now()
}
function atualizarDados (dados) {
  ultimosDadosReais = dados
  if (!simulando.value) aplicarDados(dados)
}
function atualizarStatus (s) { opcConectado.value = Boolean(s) }
function atualizarInfo (info) {
  opcConectado.value = Boolean(info.conectado)
  opcMensagem.value = info.mensagem
  if (info.ultimaLeitura && !simulando.value) ultimaLeitura.value = new Date(info.ultimaLeitura).getTime()
}
function aoConectar () { backendOnline.value = true }
function aoDesconectar () { backendOnline.value = false; opcConectado.value = false }

/* ------------------------------------------------------------------
   Tema
------------------------------------------------------------------- */
const temaEscuro = ref(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
watch(temaEscuro, v => { document.documentElement.dataset.theme = v ? 'dark' : 'light' }, { immediate: true })

/* ------------------------------------------------------------------
   Ciclo de vida
------------------------------------------------------------------- */
let relogio = null
let amostrador = null
let carencia = null

onMounted(() => {
  socket.on('connect', aoConectar)
  socket.on('disconnect', aoDesconectar)
  socket.on('connect_error', aoDesconectar)
  socket.on('opcStatus', atualizarStatus)
  socket.on('opcInfo', atualizarInfo)
  socket.on('dadosProducao', atualizarDados)
  socket.connect()

  relogio = setInterval(() => { agora.value = Date.now() }, 500)
  amostrar()
  amostrador = setInterval(amostrar, AMOSTRA_MS)
  carencia = setTimeout(() => { pronto.value = true }, CARENCIA_INICIAL_MS)
  registrar('info', 'Interface iniciada')
})

onUnmounted(() => {
  socket.off('connect', aoConectar)
  socket.off('disconnect', aoDesconectar)
  socket.off('connect_error', aoDesconectar)
  socket.off('opcStatus', atualizarStatus)
  socket.off('opcInfo', atualizarInfo)
  socket.off('dadosProducao', atualizarDados)
  socket.disconnect()
  clearInterval(relogio)
  clearInterval(amostrador)
  clearTimeout(carencia)
  clearTimeout(timerSimulacao)
  limparSinotico()
})
</script>

<template>
  <div class="pagina">
    <header class="topo">
      <div class="topo__titulo">
        <h1>Planta N1</h1>
        <p>Separação de peças por cor, S7-1500 via OPC UA</p>
      </div>

      <div class="topo__acoes">
        <span class="selo" :class="`selo--${status.tipo}`" role="status">
          <span class="selo__ponto" aria-hidden="true"></span>
          {{ status.texto }}
        </span>
        <span class="topo__leitura">Última leitura {{ textoIdade }}</span>
        <button type="button" class="botao" :aria-pressed="simulando" @click="alternarSimulacao">
          {{ simulando ? 'Parar simulação' : 'Simular dados' }}
        </button>
        <button type="button" class="botao" @click="temaEscuro = !temaEscuro">
          {{ temaEscuro ? 'Tema claro' : 'Tema escuro' }}
        </button>
      </div>
    </header>

    <main class="grade" :class="{ 'grade--parada': !comunicacaoOk }">
      <!-- Sinótico -->
      <section class="painel area-sinotico" aria-labelledby="t-sinotico">
        <div class="painel__cab">
          <h2 id="t-sinotico">Bancada</h2>
          <p class="painel__nota">{{ acaoAtual }}</p>
        </div>

        <svg class="sinotico" viewBox="0 0 800 290" role="img" :aria-label="`Desenho da bancada. ${acaoAtual}.`">
          <!-- Alimentação -->
          <g>
            <rect x="56" y="14" width="48" height="80" rx="3" class="equip" />
            <circle cx="80" cy="34" r="11" class="peca-reserva" />
            <circle cx="80" cy="60" r="11" class="peca-reserva" />
            <text x="80" y="168" text-anchor="middle" class="sin-rotulo">Alimentação</text>
          </g>

          <!-- Sensor de cor -->
          <g :class="{ 'sensor--ativo': estado === 2 && comunicacaoOk }">
            <line :x1="X_SENSOR" y1="44" :x2="X_SENSOR" y2="100" class="sensor__feixe" />
            <rect :x="X_SENSOR - 18" y="14" width="36" height="30" rx="3" class="equip sensor__corpo" />
            <text :x="X_SENSOR" y="168" text-anchor="middle" class="sin-rotulo">Sensor de cor</text>
          </g>

          <!-- Esteira -->
          <g :class="{ 'esteira--movendo': esteiraMovendo }">
            <rect x="40" y="100" width="720" height="40" rx="20" class="esteira__corpo" />
            <line x1="62" y1="120" x2="738" y2="120" class="esteira__fita" />
            <circle cx="60" cy="120" r="12" class="esteira__rolo" />
            <circle cx="740" cy="120" r="12" class="esteira__rolo" />
          </g>

          <!-- Baias e cilindros -->
          <g v-for="b in BAIAS" :key="b.chave" :class="{ 'estacao--ativa': cilindroAtivo === b.chave }">
            <g
              class="cilindro__haste"
              :style="{ transform: cilindroAtivo === b.chave ? `translateY(${CURSO_CILINDRO}px)` : 'none' }"
            >
              <rect :x="b.x - 3" y="14" width="6" height="72" class="haste" />
              <rect :x="b.x - 22" y="86" width="44" height="8" rx="2" class="placa" />
            </g>
            <rect :x="b.x - 16" y="14" width="32" height="50" rx="3" class="equip cilindro__corpo" />

            <path :d="`M ${b.x - 42} 168 V 250 H ${b.x + 42} V 168`" class="baia" />
            <rect :x="b.x - 42" y="246" width="84" height="6" :class="`tag tag--${b.chave}`" />
            <text :x="b.x" y="276" text-anchor="middle" class="sin-rotulo">
              {{ b.nome }}: <tspan class="sin-valor">{{ cont[b.chave] }}</tspan>
            </text>
          </g>

          <!-- Peça em movimento -->
          <g class="peca" :style="estiloPeca">
            <circle r="13" :class="peca.cor ? `peca--${peca.cor}` : 'peca--indefinida'" />
          </g>
        </svg>
      </section>

      <!-- Produção -->
      <section class="painel area-producao" aria-labelledby="t-producao">
        <h2 id="t-producao">Produção</h2>
        <p class="total">
          <span class="total__valor">{{ cont.total }}</span>
          <span class="total__rotulo">peças processadas</span>
        </p>

        <dl class="metricas">
          <div>
            <dt>Peças no último minuto</dt>
            <dd>{{ pecasUltimoMinuto }}</dd>
          </div>
          <div>
            <dt>Último ciclo</dt>
            <dd>{{ fmtDuracao(ultimoCiclo) }}</dd>
          </div>
          <div>
            <dt>Ciclo médio, últimas 10 peças</dt>
            <dd>{{ fmtDuracao(cicloMedio) }}</dd>
          </div>
        </dl>

        <div class="distribuicao" role="img" :aria-label="`Distribuição: ${BAIAS.map(b => `${b.nome} ${porcentagem(cont[b.chave])}%`).join(', ')}`">
          <span
            v-for="b in BAIAS"
            :key="b.chave"
            class="distribuicao__parte"
            :class="`fundo--${b.chave}`"
            :style="{ flexGrow: cont[b.chave] }"
          ></span>
        </div>

        <ul class="cores">
          <li v-for="b in BAIAS" :key="b.chave">
            <span class="amostra" :class="`fundo--${b.chave}`" aria-hidden="true"></span>
            <span class="cores__nome">{{ b.nome }}</span>
            <span class="cores__valor">{{ cont[b.chave] }}</span>
            <span class="cores__pct">{{ porcentagem(cont[b.chave]) }}%</span>
          </li>
        </ul>

        <p class="conferencia" :class="{ 'conferencia--erro': !somaConfere }">
          {{ somaConfere ? 'Soma das cores confere com o total' : 'Soma das cores não confere com o total' }}
        </p>
      </section>

      <!-- Máquina de estados -->
      <section class="painel area-estados" aria-labelledby="t-estados">
        <div class="painel__cab">
          <h2 id="t-estados">Máquina de estados</h2>
          <p class="painel__nota">Neste estado há {{ fmtDuracao(tempoNoEstado) }}</p>
        </div>
        <ol class="estados">
          <li
            v-for="e in ESTADOS"
            :key="e.id"
            class="estados__item"
            :class="{ 'estados__item--atual': e.id === estado, 'estados__item--ramo': e.ramo }"
            :aria-current="e.id === estado ? 'step' : undefined"
          >
            <span class="estados__num">{{ e.id }}</span>
            <span>{{ e.nome }}</span>
          </li>
        </ol>
        <p v-if="estadoInvalido" class="alerta-inline">Estado {{ estado }} recebido do CLP não está previsto.</p>
      </section>

      <!-- Tendência -->
      <section class="painel area-tendencia" aria-labelledby="t-tendencia">
        <div class="painel__cab">
          <h2 id="t-tendencia">Peças nos últimos 10 minutos</h2>
          <ul class="legenda-linhas">
            <li v-for="s in grafico.series" :key="s.chave">
              <span class="traco" :class="`traco--${s.chave}`" aria-hidden="true"></span>{{ s.nome }}
            </li>
          </ul>
        </div>
        <div class="grafico">
          <div class="grafico__eixo" aria-hidden="true">
            <span>{{ grafico.max }}</span>
            <span>{{ Math.round(grafico.max / 2) }}</span>
            <span>0</span>
          </div>
          <svg class="grafico__area" :viewBox="`0 0 ${LARGURA_G} ${ALTURA_G}`" preserveAspectRatio="none" role="img" aria-label="Gráfico de peças processadas nos últimos 10 minutos">
            <line v-for="y in [0, ALTURA_G / 2, ALTURA_G]" :key="y" x1="0" :x2="LARGURA_G" :y1="y" :y2="y" class="grafico__guia" vector-effect="non-scaling-stroke" />
            <polyline
              v-for="s in grafico.series"
              :key="s.chave"
              :points="s.pontos"
              class="serie"
              :class="`serie--${s.chave}`"
              fill="none"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div class="grafico__tempo" aria-hidden="true"><span>10 min atrás</span><span>agora</span></div>
      </section>

      <!-- Eventos -->
      <section class="painel area-eventos" aria-labelledby="t-eventos">
        <div class="painel__cab">
          <h2 id="t-eventos">Eventos e alarmes</h2>
          <div class="eventos__acoes">
            <label class="opcao">
              <input v-model="somenteAlarmes" type="checkbox" />
              Somente alarmes
            </label>
            <button type="button" class="botao botao--leve" :disabled="!eventos.length" @click="exportarCsv">Exportar CSV</button>
            <button type="button" class="botao botao--leve" :disabled="!eventos.length" @click="eventos = []">Limpar lista</button>
          </div>
        </div>

        <ul v-if="alarmesAtivos.length" class="ativos" role="alert">
          <li v-for="a in alarmesAtivos" :key="a">{{ a }}</li>
        </ul>

        <div class="eventos">
          <table v-if="eventosVisiveis.length">
            <thead>
              <tr><th scope="col">Hora</th><th scope="col">Tipo</th><th scope="col">Descrição</th></tr>
            </thead>
            <tbody>
              <tr v-for="ev in eventosVisiveis" :key="ev.id">
                <td class="eventos__hora">{{ fmtHora(ev.hora) }}</td>
                <td><span class="etiqueta" :class="`etiqueta--${ev.tipo}`">{{ ROTULO_TIPO[ev.tipo] }}</span></td>
                <td>{{ ev.texto }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="vazio">Nenhum evento registrado. Eles aparecem aqui conforme as peças são separadas ou a comunicação muda.</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Semi+Condensed:wght@500;600&display=swap');

/* Paleta inspirada na ISA-101: cinzas neutros, cor só para informação */
:root {
  color-scheme: light;
  --fundo: #d8dce0;
  --superficie: #eef0f2;
  --superficie-2: #e3e6e9;
  --linha: #b3b9c0;
  --texto: #1c2229;
  --texto-suave: #55606b;
  --equip: #8e969e;
  --equip-claro: #c8cdd2;
  --ativo: #2b5f8e;
  --ok: #2e7d4f;
  --aviso: #a26508;
  --alarme: #c62828;
  --alarme-fundo: #f5dcdc;
  --peca-vermelha: #c0392b;
  --peca-verde: #2e8b57;
  --peca-amarela: #dc9c12;
  --fonte: 'Barlow', 'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif;
  --fonte-condensada: 'Barlow Semi Condensed', 'Barlow', 'Arial Narrow', 'Segoe UI', sans-serif;
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --fundo: #161b20;
  --superficie: #1f252c;
  --superficie-2: #262d35;
  --linha: #38414b;
  --texto: #e1e5e9;
  --texto-suave: #98a2ad;
  --equip: #68727d;
  --equip-claro: #39424c;
  --ativo: #5d9bd3;
  --ok: #4caf7a;
  --aviso: #e2a644;
  --alarme: #ef5350;
  --alarme-fundo: #3b2124;
  --peca-vermelha: #e0574a;
  --peca-verde: #47b27a;
  --peca-amarela: #f0b93a;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--fundo);
  color: var(--texto);
  font-family: var(--fonte);
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
}
</style>

<style scoped>
/* ---------- Topo ---------- */
.topo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px 24px;
  flex-wrap: wrap;
  padding: 18px 28px;
  background: var(--superficie);
  border-bottom: 1px solid var(--linha);
}
.topo h1 {
  margin: 0;
  font-family: var(--fonte-condensada);
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.1;
}
.topo p { margin: 2px 0 0; font-size: 0.9rem; color: var(--texto-suave); }

.topo__acoes { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.topo__leitura { font-size: 0.85rem; color: var(--texto-suave); min-width: 11em; }

.selo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 0.9rem;
  border: 1px solid currentColor;
}
.selo__ponto { width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
.selo--ok { color: var(--ok); }
.selo--aviso { color: var(--aviso); }
.selo--alarme { color: #fff; background: var(--alarme); border-color: var(--alarme); }
.selo--alarme .selo__ponto { animation: piscar 1s steps(2, start) infinite; }

.botao {
  font: inherit;
  font-size: 0.88rem;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--linha);
  background: var(--superficie-2);
  color: var(--texto);
  cursor: pointer;
}
.botao:hover:not(:disabled) { border-color: var(--equip); }
.botao[aria-pressed='true'] { background: var(--ativo); border-color: var(--ativo); color: #fff; }
.botao:disabled { opacity: 0.5; cursor: default; }
.botao--leve { background: transparent; }
.botao:focus-visible, .opcao input:focus-visible { outline: 2px solid var(--ativo); outline-offset: 2px; }

/* ---------- Grade ---------- */
.grade {
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px;
  display: grid;
  gap: 16px;
  grid-template-columns: 300px minmax(0, 1fr) 320px;
  grid-template-areas:
    'sinotico sinotico producao'
    'estados tendencia producao'
    'eventos eventos eventos';
}
.area-sinotico { grid-area: sinotico; }
.area-producao { grid-area: producao; }
.area-estados { grid-area: estados; }
.area-tendencia { grid-area: tendencia; }
.area-eventos { grid-area: eventos; }

.painel {
  background: var(--superficie);
  border: 1px solid var(--linha);
  border-radius: 6px;
  padding: 18px 22px;
  min-width: 0;
}
.painel h2 {
  margin: 0;
  font-family: var(--fonte-condensada);
  font-size: 1.15rem;
  font-weight: 600;
}
.painel__cab {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.painel__nota { margin: 0; font-size: 0.88rem; color: var(--texto-suave); }

/* Valores esmaecidos quando a comunicação não é confiável */
.grade--parada .sinotico,
.grade--parada .total,
.grade--parada .metricas,
.grade--parada .estados,
.grade--parada .grafico { opacity: 0.5; transition: opacity 0.3s; }

/* ---------- Sinótico ---------- */
.sinotico { width: 100%; height: auto; display: block; }

.equip { fill: var(--equip-claro); stroke: var(--equip); stroke-width: 1.5; }
.peca-reserva { fill: var(--equip); opacity: 0.45; }
.sin-rotulo { font-family: var(--fonte); font-size: 14px; fill: var(--texto-suave); }
.sin-valor { font-weight: 700; fill: var(--texto); }

.sensor__feixe { stroke: var(--equip); stroke-width: 2; stroke-dasharray: 4 4; }
.sensor--ativo .sensor__feixe { stroke: var(--ativo); stroke-width: 3; }
.sensor--ativo .sensor__corpo { stroke: var(--ativo); stroke-width: 2.5; }

.esteira__corpo { fill: var(--superficie-2); stroke: var(--equip); stroke-width: 2; }
.esteira__fita { stroke: var(--equip); stroke-width: 3; stroke-dasharray: 2 14; stroke-linecap: round; }
.esteira__rolo { fill: var(--equip-claro); stroke: var(--equip); stroke-width: 2; }
.esteira--movendo .esteira__fita { stroke: var(--ativo); animation: fita 0.6s linear infinite; }
.esteira--movendo .esteira__corpo { stroke: var(--ativo); }

.haste { fill: var(--equip); }
.placa { fill: var(--equip); }
.cilindro__haste { transition: transform 0.4s ease-in-out; }
.estacao--ativa .cilindro__corpo { stroke: var(--ativo); stroke-width: 2.5; }
.estacao--ativa .haste,
.estacao--ativa .placa { fill: var(--ativo); }

.baia { fill: none; stroke: var(--equip); stroke-width: 2; stroke-linejoin: round; }
.tag--amarela { fill: var(--peca-amarela); }
.tag--vermelha { fill: var(--peca-vermelha); }
.tag--verde { fill: var(--peca-verde); }

.peca circle { stroke: rgba(0, 0, 0, 0.25); stroke-width: 1.5; }
.peca--indefinida { fill: var(--equip); }
.peca--amarela { fill: var(--peca-amarela); }
.peca--vermelha { fill: var(--peca-vermelha); }
.peca--verde { fill: var(--peca-verde); }

/* ---------- Produção ---------- */
.total { margin: 10px 0 18px; display: grid; }
.total__valor {
  font-family: var(--fonte-condensada);
  font-size: 4.2rem;
  font-weight: 600;
  line-height: 1;
}
.total__rotulo { font-size: 0.9rem; color: var(--texto-suave); }

.metricas { margin: 0 0 20px; display: grid; gap: 10px; }
.metricas div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--linha);
}
.metricas dt { font-size: 0.9rem; color: var(--texto-suave); }
.metricas dd { margin: 0; font-weight: 600; font-size: 1.05rem; }

.distribuicao {
  display: flex;
  height: 14px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--superficie-2);
  border: 1px solid var(--linha);
}
.distribuicao__parte { flex-basis: 0; transition: flex-grow 0.4s; }

.fundo--amarela { background: var(--peca-amarela); }
.fundo--vermelha { background: var(--peca-vermelha); }
.fundo--verde { background: var(--peca-verde); }

.cores { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.cores li {
  display: grid;
  grid-template-columns: 14px 1fr auto 3.2em;
  align-items: center;
  gap: 10px;
  font-size: 0.95rem;
}
.amostra { width: 12px; height: 12px; border-radius: 2px; }
.cores__valor { font-weight: 600; }
.cores__pct { text-align: right; color: var(--texto-suave); }

.conferencia { margin: 16px 0 0; font-size: 0.85rem; color: var(--texto-suave); }
.conferencia--erro { color: var(--alarme); font-weight: 600; }

/* ---------- Máquina de estados ---------- */
.estados { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.estados__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 0.92rem;
  color: var(--texto-suave);
}
.estados__item--ramo { margin-left: 22px; }
.estados__item--ramo::before {
  content: '';
  position: absolute;
  left: -12px;
  top: -6px;
  width: 10px;
  height: 22px;
  border-left: 1px solid var(--linha);
  border-bottom: 1px solid var(--linha);
}
.estados__num {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--linha);
  font-weight: 600;
  font-size: 0.85rem;
}
.estados__item--atual { background: var(--superficie-2); color: var(--texto); font-weight: 600; }
.estados__item--atual .estados__num { background: var(--ativo); border-color: var(--ativo); color: #fff; }

.alerta-inline { margin: 12px 0 0; color: var(--alarme); font-weight: 600; font-size: 0.9rem; }

/* ---------- Tendência ---------- */
.legenda-linhas {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 0.85rem;
  color: var(--texto-suave);
}
.legenda-linhas li { display: inline-flex; align-items: center; gap: 6px; }
.traco { width: 16px; height: 3px; border-radius: 2px; }
.traco--total { background: var(--texto); }
.traco--amarela { background: var(--peca-amarela); }
.traco--vermelha { background: var(--peca-vermelha); }
.traco--verde { background: var(--peca-verde); }

.grafico { display: grid; grid-template-columns: auto 1fr; gap: 8px; height: 200px; }
.grafico__eixo {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  text-align: right;
  font-size: 0.78rem;
  color: var(--texto-suave);
  min-width: 2ch;
  margin: -0.5em 0;
}
.grafico__area { width: 100%; height: 100%; overflow: visible; }
.grafico__guia { stroke: var(--linha); stroke-width: 1; }
.serie { stroke-width: 2; stroke-linejoin: round; }
.serie--total { stroke: var(--texto); stroke-width: 2.5; }
.serie--amarela { stroke: var(--peca-amarela); }
.serie--vermelha { stroke: var(--peca-vermelha); }
.serie--verde { stroke: var(--peca-verde); }
.grafico__tempo {
  display: flex;
  justify-content: space-between;
  margin: 6px 0 0 calc(2ch + 8px);
  font-size: 0.78rem;
  color: var(--texto-suave);
}

/* ---------- Eventos ---------- */
.eventos__acoes { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.opcao { display: inline-flex; align-items: center; gap: 6px; font-size: 0.88rem; cursor: pointer; }

.ativos {
  list-style: none;
  margin: 0 0 12px;
  padding: 10px 14px;
  border-left: 4px solid var(--alarme);
  background: var(--alarme-fundo);
  border-radius: 4px;
  display: grid;
  gap: 4px;
  font-weight: 600;
  color: var(--alarme);
}

.eventos { max-height: 280px; overflow: auto; }
.eventos table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.eventos th {
  position: sticky;
  top: 0;
  background: var(--superficie);
  text-align: left;
  font-weight: 600;
  color: var(--texto-suave);
  padding: 6px 10px;
  border-bottom: 1px solid var(--linha);
}
.eventos td { padding: 6px 10px; border-bottom: 1px solid var(--superficie-2); vertical-align: top; }
.eventos__hora { white-space: nowrap; color: var(--texto-suave); width: 7em; }

.etiqueta {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.etiqueta--alarme { color: #fff; background: var(--alarme); border-color: var(--alarme); }
.etiqueta--aviso { color: var(--aviso); }
.etiqueta--info { color: var(--texto-suave); }
.etiqueta--normal { color: var(--ok); }

.vazio { margin: 8px 0; color: var(--texto-suave); font-size: 0.9rem; }

/* ---------- Animações ---------- */
@keyframes fita { to { stroke-dashoffset: -16; } }
@keyframes piscar { to { visibility: hidden; } }

/* ---------- Responsivo ---------- */
@media (max-width: 1100px) {
  .grade {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas:
      'sinotico sinotico'
      'producao estados'
      'tendencia tendencia'
      'eventos eventos';
  }
}
@media (max-width: 700px) {
  .topo { padding: 16px; }
  .grade {
    padding: 14px;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'sinotico' 'producao' 'estados' 'tendencia' 'eventos';
  }
  .painel { padding: 16px; }
  .total__valor { font-size: 3.4rem; }
}

@media (prefers-reduced-motion: reduce) {
  .esteira--movendo .esteira__fita,
  .selo--alarme .selo__ponto { animation: none; }
  .cilindro__haste,
  .distribuicao__parte { transition: none; }
}
</style>