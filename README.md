# FlowTask — tarefas compartilhadas para o escritório

Painel Kanban (Pendente · Em andamento · Concluída), calendário e estatísticas, com **login individual**, **banco compartilhado** e **atualização em tempo real** entre os funcionários.

- Front-end: HTML + JavaScript + Tailwind (mesma identidade visual do protótipo original, sem framework).
- Banco e login: **Supabase** (PostgreSQL + Auth + Realtime), com **RLS** ligado.
- Hospedagem: **Cloudflare Pages**.
- Gestão de usuários: uma **Edge Function** do Supabase (`admin-users`) que guarda a chave `service_role` no servidor — ela nunca vai para o navegador.

> Para colocar no ar, siga **[docs/PUBLICACAO.md](docs/PUBLICACAO.md)** (≈ 30 min). Para saber o que foi (e o que não foi) testado, leia **[docs/RELATORIO_DE_TESTES.md](docs/RELATORIO_DE_TESTES.md)**.

## Quem pode o quê

| Ação | Administrador | Membro |
|---|:-:|:-:|
| Ver todas as tarefas e a equipe | ✔ | ✔ |
| Criar tarefa | ✔ (pode atribuir a qualquer pessoa) | ✔ (só para si ou sem responsável) |
| Editar tarefa | ✔ qualquer | ✔ as que criou ou que foram atribuídas a ele (título, descrição, prazo, status) |
| Mudar status (arrastar ou menu do card) | ✔ | ✔ nas tarefas que pode editar |
| Mudar prioridade | ✔ qualquer | ✔ só nas que criou |
| Mudar responsável | ✔ | ✘ |
| Excluir tarefa | ✔ | ✘ |
| Cadastrar/convidar usuário, redefinir senha, ativar/desativar, mudar nível | ✔ | ✘ |

Essas regras são impostas **no banco** (RLS + triggers em `supabase/schema.sql`), não só escondidas na tela. Uma conta desativada perde todo o acesso imediatamente. O banco impede que a organização fique sem nenhum administrador ativo.

## Estrutura

```
public/                 site (index.html, app.js, styles.css)
src/styles.src.css      fonte do Tailwind  →  npm run build:css  →  public/styles.css
scripts/build.mjs       gera dist/ (config a partir das variáveis de ambiente, headers de segurança)
scripts/serve.mjs       servidor local simples para testar dist/
supabase/schema.sql     tabelas, RLS, triggers, realtime  (rodar no SQL Editor)
supabase/functions/admin-users/   Edge Function de gestão de usuários
tests/                  testes de banco (RLS), da Edge Function e de navegador
docs/                   publicação e relatório de testes
.env.example            variáveis necessárias
```

## Rodar localmente

Requer Node 18+ e um projeto Supabase já configurado (veja [docs/PUBLICACAO.md](docs/PUBLICACAO.md), partes 1 e 2).

```bash
npm install
cp .env.example .env        # preencha SUPABASE_URL e SUPABASE_ANON_KEY
npm run dev                 # build + servidor em http://localhost:8788
```

Dependências: `@supabase/supabase-js` (copiada para `dist/vendor/` no build — o site não carrega nada de CDN de terceiros) e `tailwindcss` (apenas para regenerar o CSS). Se mudar classes do Tailwind no HTML/JS, rode `npm run build:css` e publique o `public/styles.css` atualizado.

O build **falha de propósito** se `SUPABASE_ANON_KEY` for uma chave `service_role` ou se existir qualquer variável `*SERVICE_ROLE*` no ambiente.

## Testes

```bash
npm run test:sql                       # 69 testes de RLS/triggers (precisa de um PostgreSQL DESCARTÁVEL: PGHOST/PGUSER)
npx tsx tests/edge_unit.mjs            # 19 testes da Edge Function (sem rede/banco)
node tests/e2e/run.mjs                 # 29 testes de navegador com vários usuários (Playwright + Postgres de testes)
```

Os testes de navegador usam um backend simulado (Postgres real + Edge Function real; Auth/PostgREST/Realtime simulados). Detalhes e limites no relatório de testes.
