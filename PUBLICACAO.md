# Publicação do FlowTask (Supabase + Cloudflare Pages)

Tempo estimado: 30–40 minutos. Custo: o plano gratuito de ambos atende um escritório pequeno.
Os nomes de menus podem mudar um pouco nos painéis; a lógica é a mesma.

Você vai precisar de: uma conta no [Supabase](https://supabase.com), uma conta no [Cloudflare](https://dash.cloudflare.com) e (para o Cloudflare Pages via Git) o projeto num repositório privado do GitHub/GitLab.

---

## Parte 1 — Supabase

### 1.1 Criar o projeto
1. *New project* → escolha organização, nome (`flowtask`), **senha forte do banco** (guarde num gerenciador de senhas) e região **South America (São Paulo)**.
2. Aguarde a criação (1–2 min).

### 1.2 Criar as tabelas e as regras de segurança
1. Menu **SQL Editor → New query**.
2. Abra o arquivo `supabase/schema.sql`, copie **tudo**, cole e clique **Run**. Deve terminar sem erros. (Pode ser executado de novo sem problema.)
3. Confira em **Table Editor** que existem `profiles` e `tasks`, ambas com o selo **RLS enabled**.

### 1.3 Configurar o login (importante)
Em **Authentication**:
1. **Sign In / Providers → Email**: deixe habilitado. Em *User Signups*, **desligue "Allow new users to sign up"** — assim ninguém de fora cria conta; só administradores criam usuários.
2. Ainda em Email: defina o **tamanho mínimo da senha** (recomendo 10).
3. **URL Configuration**: preencha **Site URL** com o endereço final do site (ex.: `https://flowtask.pages.dev`; pode voltar aqui depois da Parte 3) e adicione o mesmo endereço em **Redirect URLs**. Sem isso, os links de convite/recuperação de senha não funcionam.
4. **E-mails (SMTP) — recomendado antes de usar de verdade:** o envio padrão do Supabase é muito limitado (poucos e-mails por hora e só para membros da sua organização). Para a **recuperação de senha** funcionar para todos os funcionários, configure um SMTP próprio em *Authentication → Emails → SMTP Settings* (Resend, Brevo, Amazon SES, ou o SMTP do seu e-mail corporativo). Sem SMTP, use o cadastro com **senha temporária** (abaixo) e redefina senhas pelo painel de administrador.

### 1.4 Criar o primeiro administrador
1. **Authentication → Users → Add user → Create new user**: informe e-mail e senha e **marque "Auto Confirm User"**.
2. **SQL Editor**, rode uma única vez (troque o e-mail):
   ```sql
   update public.profiles
      set role = 'admin'
    where email = 'voce@seuescritorio.com.br';
   ```
   Isso só funciona no SQL Editor. Pelo site ninguém consegue se promover (testado — veja o relatório).

### 1.5 Publicar a Edge Function de gestão de usuários
É ela que permite ao administrador cadastrar pessoas pelo site sem expor a chave `service_role`.

Pelo terminal (no seu computador, dentro da pasta do projeto):
```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF     # o "ref" é o trecho antes de .supabase.co na URL do projeto
npx supabase functions deploy admin-users
```
Opcional (recomendado), restringir o domínio dos e-mails e definir o endereço do site:
```bash
npx supabase secrets set ALLOWED_EMAIL_DOMAIN=seuescritorio.com.br SITE_URL=https://flowtask.pages.dev
```
Deixe a verificação de JWT **ligada** (padrão). Não é preciso cadastrar `SUPABASE_URL`, `SUPABASE_ANON_KEY` nem `SUPABASE_SERVICE_ROLE_KEY`: o Supabase injeta essas variáveis na função automaticamente.

### 1.6 Pegar as chaves públicas
**Project Settings → API**: copie **Project URL** e a chave **anon / publishable**.
⚠ **Nunca** copie a `service_role` / *secret* para o site, para o `.env` ou para o Cloudflare.

### 1.7 Realtime
O `schema.sql` já adiciona `tasks` e `profiles` à publicação de Realtime. Se quiser conferir: **Database → Publications → supabase_realtime** deve listar as duas tabelas.

---

## Parte 2 — Testar no seu computador (opcional, recomendado)

```bash
npm install
cp .env.example .env     # cole SUPABASE_URL e SUPABASE_ANON_KEY
npm run dev              # abra http://localhost:8788
```
Para o login funcionar em `localhost`, adicione `http://localhost:8788` em *Authentication → URL Configuration → Redirect URLs*.
Entre com o administrador da etapa 1.4 e faça o roteiro de validação (Parte 5).

---

## Parte 3 — Cloudflare Pages

### Opção A — conectado ao Git (atualiza sozinho a cada commit)
1. Coloque o projeto num repositório **privado** (o `.gitignore` já exclui `.env`, `node_modules` e `dist`).
2. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → escolha o repositório.
3. Configurações de build:
   - **Framework preset:** None
   - **Build command:** `npm install && npm run build`
   - **Build output directory:** `dist`
4. **Environment variables** (Production **e** Preview):
   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | Project URL do passo 1.6 |
   | `SUPABASE_ANON_KEY` | chave **anon/publishable** do passo 1.6 |
   | `NODE_VERSION` | `20` |
5. **Save and Deploy**. Ao terminar, você recebe o endereço `https://SEU-PROJETO.pages.dev`.

### Opção B — sem Git (envio direto)
```bash
npm install && npm run build          # com o .env preenchido
npx wrangler pages deploy dist --project-name flowtask
```
(Também dá para arrastar a pasta `dist/` em *Pages → Create → Direct Upload*.) A cada mudança, rode o build e o deploy de novo.

### Depois do primeiro deploy
- Volte ao Supabase (passo 1.3.3) e coloque o endereço final em **Site URL** e **Redirect URLs**.
- Se mudar `SUPABASE_URL`/`SUPABASE_ANON_KEY`, faça um novo deploy (o valor é gravado no build).
- Os cabeçalhos de segurança (CSP, anti-clickjacking, etc.) são gerados pelo build em `dist/_headers` e já apontam para o seu projeto Supabase.
- Se usar domínio próprio no Supabase (em vez de `*.supabase.co`), basta usá-lo em `SUPABASE_URL`: o build ajusta a política de segurança.

---

## Parte 4 — Dar acesso aos funcionários

1. Entre como administrador → aba **Usuários → Cadastrar novo usuário**.
2. Escolha uma das formas:
   - **Senha temporária** (funciona sem SMTP): informe uma senha provisória e passe-a à pessoa por um canal seguro. No primeiro acesso o sistema **obriga** a trocar a senha.
   - **Convite por e-mail** (precisa de SMTP configurado — 1.3.4): a pessoa recebe um link para criar a própria senha.
3. Defina o nível: **Membro** (padrão) ou **Administrador**. Dê "Administrador" a poucas pessoas (no mínimo duas, para não depender de uma só).
4. Quando alguém sair do escritório: **Desativar** (o acesso é cortado na hora, o histórico das tarefas é mantido).
5. Esqueceu a senha? A pessoa usa "Esqueci minha senha" na tela de login (precisa de SMTP) ou o administrador usa **Redefinir senha**.

**Camada extra (opcional):** para que *nem a tela de login* seja visível a quem não é do escritório, coloque o site atrás do **Cloudflare Access** (Zero Trust → Access → Applications, política "e-mails terminando em @seuescritorio.com.br"). Lembre de proteger também o domínio `*.pages.dev` de *preview*. O Access é uma proteção adicional; o que garante a privacidade dos dados é o login + RLS do Supabase.

---

## Parte 5 — Roteiro de validação no escritório (15 min, 2 pessoas)

1. Administrador entra, cadastra uma pessoa-teste (senha temporária) e cria 3 tarefas com prioridades diferentes, atribuindo uma à pessoa-teste.
2. Pessoa-teste entra em **outro computador/navegador**; troca a senha; confirma que vê as 3 tarefas e que o indicador no topo diz **"Ao vivo"**.
3. Pessoa-teste move a tarefa dela para "Em andamento" → o administrador vê mudar **sem recarregar**.
4. Pessoa-teste tenta abrir uma tarefa de outra pessoa → só leitura; sem botão de excluir.
5. Administrador desativa a pessoa-teste → a sessão dela encerra e o novo login é recusado.
6. Administrador exporta o CSV e abre no Excel (acentos devem aparecer corretos).
7. Abra o site no celular: navegação inferior e cards legíveis.

## Manutenção
- **Backup:** no plano gratuito do Supabase não há backups automáticos recuperáveis por você; exporte o CSV periodicamente ou ative backups num plano pago.
- **Projeto pausado:** projetos gratuitos do Supabase são pausados após ~1 semana sem uso; é só reativar no painel.
- **Atualizar o schema no futuro:** o `schema.sql` é reexecutável; mudanças novas devem vir como scripts adicionais.
