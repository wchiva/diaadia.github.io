# Relatório de testes — FlowTask MVP (13/11/2026)

## Leia primeiro: o que "testado" significa aqui

O ambiente de desenvolvimento não tinha acesso à internet nem a um projeto Supabase real. Por isso os testes foram feitos em três camadas, e é importante saber qual é qual:

| Camada | O que é **real** | O que é **simulado** |
|---|---|---|
| **A. Banco** (`tests/sql`) | PostgreSQL 16 executando o `schema.sql` de verdade (tabelas, RLS, triggers, funções) | A parte do Supabase que o banco usa (`auth.users`, `auth.uid()`, papéis `anon`/`authenticated`/`service_role`) é uma réplica mínima (`00_supabase_shim.sql`) |
| **B. Edge Function** (`tests/edge_unit.mjs` + e2e) | O código real da função (`handler.ts`) | A biblioteca `supabase-js` e a API Admin do Auth são substituídas por *fakes* |
| **C. Navegador** (`tests/e2e`) | O `index.html`/`app.js` reais no Chromium, com vários usuários ao mesmo tempo, CSP idêntico ao de produção, e o PostgreSQL real (RLS real) por trás | Login/sessão (Auth), tradução das chamadas para SQL (PostgREST), tempo real (Realtime) e a própria biblioteca `supabase-js` são **simulados** |

**Conclusão honesta:** as *regras* (quem pode o quê, validações, segurança do banco, comportamento da tela) foram verificadas com banco real. A *integração com os serviços reais do Supabase e do Cloudflare* **não** foi verificada — isso é o que a sua validação no escritório precisa confirmar (roteiro na Parte 5 de `docs/PUBLICACAO.md`).

## Resultado final (última execução, todas verdes)

| Suíte | Resultado |
|---|---|
| Banco / RLS (`npm run test:sql`) | **69/69** (chamadas de teste = resultados registrados) |
| Edge Function (`tests/edge_unit.mjs`) | **19/19** |
| Navegador, vários usuários (`tests/e2e/run.mjs`) | **29/29**, repetido várias vezes sem intermitência após as correções |
| Build (`scripts/build.mjs`) | 5 cenários verificados em cópia temporária: falha sem variáveis, falha com `http://`, falha se a "anon" for `service_role`, falha se existir variável `SERVICE_ROLE`, sucesso gerando `config.js` e `_headers` corretos |

## Seus 14 itens de verificação

| # | Item | Status | Como foi verificado / ressalva |
|---|---|---|---|
| 1 | Login funciona | ✔ com ressalva | Senha errada (mensagem), senha certa, sessão que persiste ao recarregar, logout. **Auth simulado** — não testado contra o Supabase Auth real. |
| 2 | Não autenticados bloqueados | ✔ | Tela: visitante só vê o login, sem dados. Banco: `anon` não lê `tasks`/`profiles`, não insere, não chama funções de admin (testes SQL reais). |
| 3 | Admin cadastra usuários | ✔ com ressalva | Cadastro com senha temporária, e-mail duplicado recusado, troca de senha obrigatória no 1º acesso, redefinição de senha, mudança de nível, desativar/reativar — usando o código real da função e o banco real. **Envio de e-mail (convite/recuperação) não testado**; a API Admin do Auth é simulada. |
| 4 | Membros não fazem operações de admin | ✔ | Pela tela (sem painel/controles) **e** atacando a API direto como membro: não altera/exclui tarefa alheia, não se promove, não atribui a outros, não forja autor, e a Edge Function responde 403 sem criar nada. |
| 5 | Tarefa criada aparece para os demais | ✔ com ressalva | Admin→membros e membro→admin, sem recarregar. **Realtime simulado** (com checagem de RLS por usuário); o Realtime real do Supabase não foi exercitado. |
| 6 | Edição refletida nas outras sessões | ✔ com a mesma ressalva | Título, prioridade e responsável; `updated_by` gravado. |
| 7 | Exclusão | ✔ | Some das duas sessões e do banco; membro não vê o botão e o banco recusa. |
| 8 | Filtros | ✔ | Responsável, status, prioridade, prazo (intervalo), "sem responsável", combinação e limpar. |
| 9 | Prioridades | ✔ | Alta = vermelho, Média = âmbar, Baixa = verde (borda do card + selo). Conferido nas classes e em captura de tela. |
| 10 | Exportação CSV | ✔ com ressalva | Arquivo baixado e lido por um parser RFC 4180: BOM UTF-8, aspas, vírgulas, quebras de linha, separador `,` ou `;`, filtro "só concluídas", proteção contra fórmulas (`=`, `@`…). **Não abri no Excel real.** |
| 11 | Dados persistem após sair/entrar | ✔ | Mesmo número de tarefas ao voltar; tela limpa no logout. |
| 12 | Diferentes navegadores | **✘ NÃO TESTADO** | Só Chromium estava disponível. Firefox, Safari/iOS e celulares reais **não** foram testados. O layout de celular foi verificado só por emulação de tela 390×844. |
| 13 | Sem erros críticos no console | ✔ | Nenhum erro de página, violação de CSP ou requisição falha em toda a suíte. Foram *excluídos* da checagem: respostas 4xx esperadas nos testes negativos (login errado, banco negando acesso) e 3 erros tratados que o app registra de propósito. |
| 14 | RLS impede acessos indevidos | ✔ | 69 testes no PostgreSQL real, cobrindo `anon`, membro, admin, usuário inativo, `service_role`, colunas protegidas, forja de autor, validações e regra do último admin. Ressalva: o Supabase real não foi usado (réplica mínima do esquema `auth`). |

Duas ou mais pessoas simultâneas: ✔ — 1 administrador + 2 membros + 1 usuário criado durante o teste, cada um em sessão isolada, mais uma sessão extra em tela de celular.

## Problemas encontrados durante os testes (e corrigidos)

1. **Testes de segurança que nunca rodavam.** Uma função de teste tinha erro de sintaxe, então 13 dos 69 testes de RLS eram *silenciosamente ignorados* e o relatório mostrava "56 passaram". Corrigido; o executor agora falha se algum teste não registrar resultado.
2. **Bug do app:** ao desativar um usuário, a mensagem "conta desativada" era apagada por um evento de logout atrasado. Corrigido.
3. **Bug do app:** o mesmo evento atrasado limpava o formulário de login se a pessoa já tivesse começado a digitar. Corrigido (o encerramento de sessão agora é idempotente).
4. **Protótipo → produção:** IDs ausentes na barra de usuário do celular (causaria erro de JavaScript); `logo.png` inexistente gerava erro no console; estilo inline incompatível com uma política de segurança estrita. Corrigidos.
5. **Defeitos só do meu código de teste** (nada a ver com o produto): quebra de linha do `json_agg`, ordem de chaves em comparação, estado compartilhado num *fake*. Corrigidos.

## Mudanças de comportamento em relação ao protótipo original

- Com filtro de **prazo** ativo, tarefas **sem prazo** deixam de aparecer (no original apareciam sempre). Fica coerente com a exportação, que já as excluía.
- Rótulos de status: "A Fazer" → **Pendente**, "Concluído" → **Concluída**.
- Tudo que era `localStorage` agora vem do banco. **Os dados do protótipo antigo não migram automaticamente** (eram só de teste; se precisar, exporte o CSV do protótipo e cadastre as tarefas).
- Cadastro de usuário deixou de ser "só um nome na lista": agora cria uma conta de login real.

## Preservado do protótipo
Kanban com arrastar-e-soltar, calendário mensal, aba de usuários, estatísticas, exportação CSV (tarefas, concluídas, usuários, por intervalo de datas), filtros por responsável e por data, tema escuro e cor de destaque laranja. Adicionados: filtros de status/prioridade, edição, exclusão, menu de status no card (necessário no celular, onde arrastar não funciona), navegação inferior no celular.

## O que ainda precisa ser feito/confirmado manualmente
1. Criar o projeto Supabase, rodar o `schema.sql`, desligar o cadastro público, definir Site URL/Redirect URLs, criar o primeiro admin (Partes 1.1–1.4).
2. Publicar a Edge Function `admin-users` (1.5) — sem ela, cadastrar/desativar usuários pelo site não funciona.
3. **Configurar SMTP** (1.3.4) se quiser "Esqueci minha senha" e convites por e-mail para todos.
4. Rodar `npm install` uma vez (gera o `package-lock.json`; recomendo versioná-lo) e conferir que o build do Cloudflare passa — o build com a biblioteca `supabase-js` real não pôde ser executado aqui (usei um *stub* só para validar o script).
5. Rodar o roteiro de validação (Parte 5) com 2 pessoas, em pelo menos Chrome + um segundo navegador + um celular.
6. Confirmar no Supabase que o Realtime entrega as mudanças (indicador "Ao vivo" no topo; se cair, o app reconsulta periodicamente como plano B — esse plano B **não** foi exercitado nos testes).

## Limitações conhecidas do MVP
- Sem 2FA, sem registro de auditoria (quem mudou o quê além de "criado por" e "atualizado por/em"), sem comentários/anexos/notificações de prazo.
- Usuários são **desativados**, não excluídos (preserva o histórico).
- Membros só criam tarefas para si ou sem responsável; reatribuir e excluir é com o administrador (decisão de permissão, fácil de mudar em `schema.sql`).
- Redefinição de senha pelo administrador usa a caixa de diálogo do navegador.
- A senha temporária é visível ao administrador que a define (transmita por canal seguro; a pessoa é obrigada a trocá-la).
- O CSS do Tailwind é pré-compilado: mudou classes? Rode `npm run build:css`.
- Plano gratuito do Supabase: projeto pausa após inatividade e não oferece backup recuperável por conta própria.
- Testes de carga, acessibilidade e expiração/renovação de sessão não foram feitos.
