# Relação de NodeIds — Planta N1 (Somativa_1)

Servidor OPC UA: `opc.tcp://169.254.171.199:4840`
Security policy: None | Message security mode: None
Server interface: `vue` | URI do namespace: `http://vue`

Preencha a coluna **Identificador** com o valor mostrado no TIA Portal em
*OPC UA communication > Server interfaces > vue > DB_Producao_N1 > (variável) > Properties > OPC UA attributes > Node ID*.
O índice `ns` é descoberto pelo backend na conexão e aparece no console ao rodar `node server.js`
(linha "NodeIds lidos"). Copie de lá a coluna **NodeId completo**.

| Dado              | Variável no DB_Producao_N1 | Tipo | URI do namespace | Identificador | NodeId completo |
|-------------------|----------------------------|------|------------------|---------------|-----------------|
| Peças vermelhas   | contPecasVermelhas         | Int  | http://vue       | i=            | ns=  ;i=        |
| Peças verdes      | contPecasVerdes            | Int  | http://vue       | i=            | ns=  ;i=        |
| Peças amarelas    | contPecasAmarelas          | Int  | http://vue       | i=            | ns=  ;i=        |
| Produção total    | contPecasTotal             | Int  | http://vue       | i=            | ns=  ;i=        |
| Estado da máquina | estadoMaquina              | Int  | http://vue       | i=            | ns=  ;i=        |

Os mesmos identificadores devem estar no objeto `IDS` do arquivo `backend/server.js`.
