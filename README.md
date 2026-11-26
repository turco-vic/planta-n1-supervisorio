# Planta N1 - Separadora: contagem e supervisão da produção

Gêmeo Exxer ⇄ Modbus TCP ⇄ S7-1500 (PLCSIM Advanced) ⇄ OPC UA ⇄ Node.js ⇄ Socket.IO ⇄ Vue

## Estrutura

```
planta-n1/                 projeto Vue (interface gráfica)
├── src/App.vue            tela: 4 indicadores circulares, estado da máquina e comunicação OPC UA
├── backend/server.js      cliente OPC UA + servidor Socket.IO (porta 3000)
├── tia/projeto_TIA/       projeto TIA Portal V17 (só no zip entregue no Teams; abrir Semaforo.ap17)
├── tia/FB_ContagemN1.scl  DB_Producao_N1 + FB de contagem (fonte SCL)
├── tia/chamada_OB1.scl    chamada do FB no Main [OB1]
└── NODEIDS.md             relação dos NodeIds
```

## Endereços utilizados

| Item                          | Valor                              |
|-------------------------------|------------------------------------|
| CLP virtual (PLCSIM Advanced) | 169.254.171.199                    |
| Gêmeo Exxer (servidor Modbus) | 169.254.171.200, porta 502         |
| Servidor OPC UA do S7-1500    | opc.tcp://169.254.171.199:4840     |
| Backend Node.js               | http://localhost:3000              |
| Interface Vue                 | http://localhost:5173              |

## Pré-requisitos

- TIA Portal V17 e S7-PLCSIM Advanced V4.0
- Node.js 20 LTS ou mais recente (`node -v` no PowerShell)
- Simulador Exxer com o gêmeo da Planta N1

## 1. Programa do CLP (TIA Portal)

1. No contador das requisições Modbus, use `Clock_10Hz` (com 2 Hz a leitura fica lenta e o pulso do sensor da rampa pode não ser lido).
2. Crie o **DB_Producao_N1** (Global DB) com `contPecasVermelhas`, `contPecasVerdes`, `contPecasAmarelas`, `contPecasTotal` e `estadoMaquina`, todos Int e marcados como *Retain*.
3. Crie o **FB_ContagemN1** com o código de `tia/FB_ContagemN1.scl`. Ou importe o arquivo em *External source files* e use *Generate blocks from source*.
4. Chame o FB no Main [OB1], depois do FB da aplicação, como em `tia/chamada_OB1.scl`.

A contagem usa borda de subida (`R_TRIG`) nos sensores das rampas, então cada peça é contada uma vez e na cor da rampa onde caiu. O total é sempre a soma das três cores.

## 2. Servidor OPC UA (TIA Portal)

1. CPU > Properties > *General > Runtime licenses > OPC UA*: **SIMATIC OPC UA S7-1500 medium** (exigida pela CPU 1516).
2. *OPC UA > Server > General*: marque **Activate OPC UA server**, porta 4840.
3. Segurança para o laboratório: **SecurityPolicy None** e **MessageSecurityMode None**, com acesso de convidado (guest) habilitado.
4. *OPC UA communication > Server interfaces > Add new server interface*, nome **vue**. Arraste o **DB_Producao_N1** para dentro dela.
5. *Generate local data* e *Consistency check*. Compile hardware e software, carregue no PLCSIM Advanced e coloque a CPU em RUN.
6. Anote os identificadores (`i=...`) de cada variável no `NODEIDS.md`.

## 3. Backend Node.js

No PowerShell, dentro da pasta `backend`:

```
npm.cmd install
```

Abra `backend/server.js` e confira o bloco de configuração no topo (já está com os valores do projeto):

- `ENDPOINT`: endereço do servidor OPC UA do CLP
- `URI_NAMESPACE`: `http://vue`
- `IDS`: os identificadores anotados no TIA

Execute:

```
node server.js
```

O console mostra os NodeIds completos (`ns=4;i=3` a `ns=4;i=7`) e a mensagem "CONECTADO - Comunicação com o S7-1500 ativa". Em http://localhost:3000 aparece um JSON com os valores lidos. O aviso de "certificate subjectAltName" pode ser ignorado, porque a conexão usa SecurityPolicy None.

## 4. Interface Vue

Em outra janela do PowerShell, na pasta principal `planta-n1`:

```
npm.cmd install
npm.cmd run dev
```

Abra o endereço informado pelo Vite (normalmente http://localhost:5173). Os valores atualizam sozinhos, sem recarregar a página.

## Ordem de execução na demonstração

1. Abrir o PLCSIM Advanced como administrador, selecionar *PLCSIM Virtual Eth. Adapter* e iniciar a instância (IP 169.254.171.199, máscara 255.255.0.0).
2. No TIA, compilar, fazer o download pelo adaptador virtual (PN/IE_1, marcar *Show devices with the same addresses*), colocar em RUN e clicar em *Go online*.
3. Abrir o gêmeo Exxer da Planta N1. Em *Configurações*, conferir IP **169.254.171.200** e porta **502**. O rodapé deve mostrar **Conectado**.
4. Ligar a chave geral (estado 0 para 1) e apertar S1/Start (estado 1 para 2).
5. `node server.js` na pasta `backend` e conferir o JSON em http://localhost:3000.
6. `npm.cmd run dev` na pasta principal e abrir http://localhost:5173.
7. Inserir uma peça de cada cor e mostrar cada incremento na tela, sem recarregar a página.
8. Interromper a comunicação (Ctrl+C no backend): o selo muda para **Backend offline** e os valores ficam parados. Rodar `node server.js` de novo: a tela volta para **CLP conectado** com os mesmos contadores, porque eles ficam no DB Retain do CLP.
9. Comprovar a consistência: vermelhas + verdes + amarelas = produção total (na tela, no JSON e no DB).

## Solução de problemas

| Sintoma | O que verificar |
|---|---|
| "o servidor OPC UA não respondeu" | CPU em RUN? Teste `Test-NetConnection 169.254.171.199 -Port 4840`. |
| "namespace http://vue não encontrado" | A server interface `vue` foi criada e carregada no CLP? |
| "leitura inválida ... BadNodeIdUnknown" | Identificador errado em `IDS`; confira no TIA. |
| Interface mostra "Backend sem resposta" | O `node server.js` está rodando na porta 3000? |
| Exxer mostra "Desconectado" | O IP do Exxer está na rede do laboratório (10.x)? Trocar para 169.254.171.200 em Configurações. Conferir a regra de firewall de entrada TCP 502. |
| Start não muda o estado | Chave geral ligada e emergência liberada? Segurar o S1 por cerca de 1 s, porque a leitura Modbus é cíclica. |
| Contador não incrementa | Monitore `"leituraModbus".dadosLeitura[20]` e confira se o bit da rampa muda. Confirme o `Clock_10Hz`. |
