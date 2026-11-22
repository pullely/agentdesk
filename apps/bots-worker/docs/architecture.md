# bots-worker — architecture

Routes (all under `/v1/organizations/{org}`, actor headers from api-edge):

| Route | Permission |
|---|---|
| GET /bots | project.list |
| GET/PUT /projects/{p}/bot | run.read / bot.config.write |
| GET /projects/{p}/bot/versions, GET/PUT /bot/draft | run.read / bot.config.write |
| POST /projects/{p}/bot/publish | bot.publish |
| GET/PUT /projects/{p}/grants | run.read / connector.manage |
| POST /projects/{p}/bot/playground | bot.config.write |
| GET /projects/{p}/runs, GET /runs/{run} | run.read |

Publishing flips the draft to published and the previous published to superseded in one D1 batch, snapshotting the grants into the version. A grant on an MCP tool records the tool description hash the admin saw; connectors-worker clears matches when a sync changes a description. Every write appends an audit event (category `agents`).
