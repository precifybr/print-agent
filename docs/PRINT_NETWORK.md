# DALMAGO Print Network

Modelo: device-registered print network with authenticated edge execution.

## Fluxo obrigatorio

1. Frontend cria registros em `print_jobs` com `type` em `order`, `teste` ou `reprint`.
2. Print Agent inicia somente com configuracao importada e sessao Supabase valida.
3. Print Agent executa `POST /functions/v1/agent-bootstrap` com `Authorization: Bearer <jwt>`.
4. Se o bootstrap falhar, o Agent para polling, heartbeat e impressao.
5. Apos bootstrap, o Agent envia impressoras Windows para `POST /functions/v1/print-agent/printers`.
6. Backend grava `printer_devices` e marca como `offline` as impressoras nao reportadas.
7. Agent envia `POST /functions/v1/print-agent/heartbeat` a cada 45s.
8. Agent consulta `GET /functions/v1/print-agent/pending?limit=10` somente com `x-print-agent-token`.
9. Jobs impressos sao confirmados em `POST /functions/v1/print-agent/:id/done`.
10. Falhas sao registradas em `POST /functions/v1/print-agent/:id/error`.

## Regras de consistencia

- `print_jobs.type` tem check constraint para bloquear valores fora de `order`, `teste`, `reprint`.
- `printer_devices` e a fonte oficial das impressoras disponiveis.
- O Agent nao inicia polling sem JWT valido, sessao valida e `print_agent_token`.
- Mudanca de `tokenVersion` no polling dispara novo bootstrap.
- Impressora local so e usada depois de existir mapeamento vindo do backend.

## Deploy Supabase

Arquivos preparados:

- `supabase/migrations/20260505000000_print_network.sql`
- `supabase/functions/agent-bootstrap/index.ts`
- `supabase/functions/print-agent/index.ts`

As Edge Functions dependem das variaveis padrao do Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Nenhum segredo deve ser versionado no repositorio.
