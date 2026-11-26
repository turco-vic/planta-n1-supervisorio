# Relação de NodeIds - Planta N1 (Somativa_1)

Servidor OPC UA: `opc.tcp://169.254.171.199:4840`
Security policy: None | Message security mode: None (acesso guest)
Licença: SIMATIC OPC UA S7-1500 medium (CPU 1516-3 PN/DP)
Server interface: `vue` | URI do namespace: `http://vue`

Valores conferidos na demonstração de 19/11/2026: o TIA mostra `http://vue;i=N` em
*OPC UA communication > Server interfaces > vue > DB_Producao_N1 > (variável) > Properties > OPC UA attributes > Node ID*,
e o backend localiza o índice do namespace na conexão (console de `node server.js`, linha "NodeIds lidos").

| Dado              | Variável no DB_Producao_N1 | Tipo | URI do namespace | Identificador | NodeId completo |
|-------------------|----------------------------|------|------------------|---------------|-----------------|
| Peças vermelhas   | contPecasVermelhas         | Int  | http://vue       | i=3           | ns=4;i=3        |
| Peças verdes      | contPecasVerdes            | Int  | http://vue       | i=4           | ns=4;i=4        |
| Peças amarelas    | contPecasAmarelas          | Int  | http://vue       | i=5           | ns=4;i=5        |
| Produção total    | contPecasTotal             | Int  | http://vue       | i=6           | ns=4;i=6        |
| Estado da máquina | estadoMaquina              | Int  | http://vue       | i=7           | ns=4;i=7        |

Os mesmos identificadores estão no objeto `IDS` do arquivo `backend/server.js`.
O índice `ns=4` é descoberto pelo backend lendo o NamespaceArray (nó `i=2255`), então não fica fixo no código.
