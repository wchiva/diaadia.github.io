-- Testes de RLS / triggers do schema.sql num PostgreSQL local (com shim).
-- Cada teste registra PASS/FAIL em test.results. Ao final, imprime o resumo.

create schema if not exists test;
drop table if exists test.results;
create table test.results (n serial, label text, ok boolean, detail text);
grant usage on schema test to public;
grant all on test.results to public;
grant usage on sequence test.results_n_seq to public;

create or replace function test.as_user(uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create or replace function test.as_anon() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
  execute 'set role anon';
end $$;

create or replace function test.as_service() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
  execute 'set role service_role';
end $$;

create or replace function test.as_super() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end $$;

-- precisa dar certo
create or replace function test.ok(label text, sql text) returns void language plpgsql as $$
begin
  execute sql;
  insert into test.results(label, ok, detail) values (label, true, '');
exception when others then
  insert into test.results(label, ok, detail) values (label, false, 'erro inesperado: ' || sqlerrm);
end $$;

-- precisa falhar (com SQLSTATE opcional)
create or replace function test.fails(label text, sql text, want_state text default null) returns void language plpgsql as $$
begin
  execute sql;
  insert into test.results(label, ok, detail) values (label, false, 'deveria ter falhado e passou');
exception when others then
  if want_state is null or sqlstate = want_state then
    insert into test.results(label, ok, detail) values (label, true, sqlstate || ' ' || sqlerrm);
  else
    insert into test.results(label, ok, detail) values (label, false, 'falhou com outro código: ' || sqlstate || ' ' || sqlerrm);
  end if;
end $$;

-- precisa afetar/retornar exatamente N linhas
create or replace function test.rows(label text, sql text, want int) returns void language plpgsql as $$
declare got int;
begin
  -- CTE (e não subconsulta) para aceitar também UPDATE/DELETE ... RETURNING
  execute 'with q as (' || sql || ') select count(*) from q' into got;
  insert into test.results(label, ok, detail) values (label, got = want, 'linhas=' || got || ' esperado=' || want);
exception when others then
  insert into test.results(label, ok, detail) values (label, false, 'erro: ' || sqlerrm);
end $$;

create or replace function test.eq(label text, got text, want text) returns void language plpgsql as $$
begin
  insert into test.results(label, ok, detail) values (label, got is not distinct from want, 'obtido=' || coalesce(got,'NULL') || ' esperado=' || coalesce(want,'NULL'));
end $$;

-- ---------------------------------------------------------------- dados
select test.as_super();

-- trigger deve ignorar "role: admin" vindo dos metadados do usuário
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a', 'admin@x.com',  '{"full_name":"Ana Admin"}'),
 ('00000000-0000-0000-0000-00000000000b', 'bruno@x.com',  '{"full_name":"Bruno","role":"admin"}'),
 ('00000000-0000-0000-0000-00000000000c', 'carla@x.com',  '{"full_name":"Carla"}'),
 ('00000000-0000-0000-0000-00000000000d', 'diego@x.com',  '{}');

select test.eq('perfil criado automaticamente (4 usuários)', (select count(*)::text from public.profiles), '4');
select test.eq('metadados {"role":"admin"} NÃO viram admin', (select role from public.profiles where email='bruno@x.com'), 'member');
select test.eq('nome vem dos metadados', (select full_name from public.profiles where email='bruno@x.com'), 'Bruno');
select test.eq('sem nome: usa parte local do e-mail', (select full_name from public.profiles where email='diego@x.com'), 'diego');

-- primeiro admin, como no passo a passo (SQL Editor = superusuário)
select test.ok('SQL Editor promove o primeiro admin', $$update public.profiles set role='admin' where email='admin@x.com'$$);
select test.eq('primeiro admin promovido', (select role from public.profiles where email='admin@x.com'), 'admin');

-- Diego será desativado pelo admin mais adiante; por ora, tarefas-base criadas como super
insert into public.tasks (id, title, priority, status, created_by, assignee_id) values
 ('10000000-0000-0000-0000-000000000001', 'Tarefa da Carla',  'medium', 'todo', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c'),
 ('10000000-0000-0000-0000-000000000002', 'Tarefa do Admin atribuída ao Bruno', 'high', 'todo', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');

-- ---------------------------------------------------------------- ANON
select test.as_anon();
select test.fails('anon NÃO lê tasks',    $$select * from public.tasks$$,    '42501');
select test.fails('anon NÃO lê profiles', $$select * from public.profiles$$, '42501');
select test.fails('anon NÃO insere task', $$insert into public.tasks(title) values ('x')$$, '42501');
select test.fails('anon NÃO executa app_is_admin()', $$select public.app_is_admin()$$, '42501');

-- ---------------------------------------------------------------- MEMBRO (Bruno)
select test.as_user('00000000-0000-0000-0000-00000000000b');
select test.rows('membro vê todas as tarefas', 'select * from public.tasks', 2);
select test.rows('membro vê a equipe (4 perfis)', 'select * from public.profiles', 4);

select test.ok('membro cria tarefa própria',
  $$insert into public.tasks(id,title,priority) values ('10000000-0000-0000-0000-0000000000b1','Do Bruno','low')$$);
select test.eq('autor registrado = Bruno', (select created_by::text from public.tasks where id='10000000-0000-0000-0000-0000000000b1'), '00000000-0000-0000-0000-00000000000b');

select test.ok('membro tenta forjar created_by (é sobrescrito)',
  $$insert into public.tasks(id,title,created_by) values ('10000000-0000-0000-0000-0000000000b2','Forjada','00000000-0000-0000-0000-00000000000a')$$);
select test.eq('created_by forjado foi corrigido para Bruno', (select created_by::text from public.tasks where id='10000000-0000-0000-0000-0000000000b2'), '00000000-0000-0000-0000-00000000000b');

select test.ok('membro cria tarefa atribuída a si',
  $$insert into public.tasks(title,assignee_id) values ('Para mim','00000000-0000-0000-0000-00000000000b')$$);
select test.fails('membro NÃO atribui tarefa a outra pessoa',
  $$insert into public.tasks(title,assignee_id) values ('Para Carla','00000000-0000-0000-0000-00000000000c')$$, '42501');
select test.fails('prioridade inválida rejeitada', $$insert into public.tasks(title,priority) values ('x','urgente')$$, '23514');
select test.fails('status inválido rejeitado',     $$insert into public.tasks(title,status) values ('x','feito')$$, '23514');
select test.fails('título vazio rejeitado',         $$insert into public.tasks(title) values ('   ')$$, '23514');
select test.fails('título > 200 caracteres rejeitado', $$insert into public.tasks(title) values (repeat('a',201))$$, '23514');
select test.fails('descrição > 2000 caracteres rejeitada', $$insert into public.tasks(title,description) values ('ok',repeat('a',2001))$$, '23514');

select test.rows('membro atualiza status da tarefa que criou',
  $$update public.tasks set status='in_progress' where id='10000000-0000-0000-0000-0000000000b1' returning 1$$, 1);
select test.rows('membro atualiza título de tarefa atribuída a ele (criada pelo admin)',
  $$update public.tasks set title='Novo título', status='in_progress' where id='10000000-0000-0000-0000-000000000002' returning 1$$, 1);
select test.rows('membro NÃO altera tarefa alheia (RLS: 0 linhas)',
  $$update public.tasks set status='done' where id='10000000-0000-0000-0000-000000000001' returning 1$$, 0);
select test.fails('membro NÃO muda responsável',
  $$update public.tasks set assignee_id='00000000-0000-0000-0000-00000000000c' where id='10000000-0000-0000-0000-000000000002'$$, '42501');
select test.fails('membro NÃO muda prioridade de tarefa que não criou',
  $$update public.tasks set priority='low' where id='10000000-0000-0000-0000-000000000002'$$, '42501');
select test.ok('membro muda prioridade da tarefa que criou',
  $$update public.tasks set priority='high' where id='10000000-0000-0000-0000-0000000000b1'$$);
select test.ok('membro tenta trocar created_by (é ignorado)',
  $$update public.tasks set created_by='00000000-0000-0000-0000-00000000000c' where id='10000000-0000-0000-0000-0000000000b1'$$);
select test.eq('created_by permaneceu', (select created_by::text from public.tasks where id='10000000-0000-0000-0000-0000000000b1'), '00000000-0000-0000-0000-00000000000b');
select test.eq('updated_by = Bruno', (select updated_by::text from public.tasks where id='10000000-0000-0000-0000-0000000000b1'), '00000000-0000-0000-0000-00000000000b');
select test.rows('membro NÃO exclui nem a própria tarefa (0 linhas)',
  $$delete from public.tasks where id='10000000-0000-0000-0000-0000000000b1' returning 1$$, 0);

-- perfis
select test.fails('membro NÃO se promove a admin', $$update public.profiles set role='admin' where id='00000000-0000-0000-0000-00000000000b'$$, '42501');
select test.fails('membro NÃO se reativa/desativa', $$update public.profiles set is_active=false where id='00000000-0000-0000-0000-00000000000b'$$, '42501');
select test.fails('membro NÃO altera o próprio e-mail (privilégio de coluna)', $$update public.profiles set email='x@y.com' where id='00000000-0000-0000-0000-00000000000b'$$, '42501');
select test.ok('membro altera o próprio nome/cargo', $$update public.profiles set full_name='Bruno S.', job_title='Analista' where id='00000000-0000-0000-0000-00000000000b'$$);
select test.rows('membro NÃO altera perfil de outro (0 linhas)', $$update public.profiles set full_name='Hack' where id='00000000-0000-0000-0000-00000000000c' returning 1$$, 0);
select test.fails('membro NÃO liga must_change_password', $$update public.profiles set must_change_password=true where id='00000000-0000-0000-0000-00000000000b'$$, '42501');
select test.fails('membro NÃO insere perfil', $$insert into public.profiles(id,email) values (gen_random_uuid(),'z@z.com')$$, '42501');
select test.fails('membro NÃO exclui perfil', $$delete from public.profiles where id='00000000-0000-0000-0000-00000000000c'$$, '42501');

-- ---------------------------------------------------------------- ADMIN (Ana)
select test.as_user('00000000-0000-0000-0000-00000000000a');
select test.rows('admin vê todas as tarefas', 'select * from public.tasks', 5);
select test.ok('admin atribui tarefa a outra pessoa',
  $$update public.tasks set assignee_id='00000000-0000-0000-0000-00000000000c' where id='10000000-0000-0000-0000-0000000000b1'$$);
select test.ok('admin altera prioridade de tarefa alheia',
  $$update public.tasks set priority='low' where id='10000000-0000-0000-0000-000000000001'$$);
select test.ok('admin cria tarefa já atribuída a outra pessoa',
  $$insert into public.tasks(id,title,assignee_id) values ('10000000-0000-0000-0000-0000000000a1','Do admin p/ Carla','00000000-0000-0000-0000-00000000000c')$$);
select test.rows('admin exclui tarefa', $$delete from public.tasks where id='10000000-0000-0000-0000-0000000000a1' returning 1$$, 1);
select test.ok('admin promove Bruno a admin', $$update public.profiles set role='admin' where id='00000000-0000-0000-0000-00000000000b'$$);
select test.ok('admin rebaixa Bruno de volta', $$update public.profiles set role='member' where id='00000000-0000-0000-0000-00000000000b'$$);
select test.fails('admin NÃO consegue ficar sem admin ativo (auto-rebaixamento do único admin)',
  $$update public.profiles set role='member' where id='00000000-0000-0000-0000-00000000000a'$$, 'P0001');
select test.fails('admin NÃO se desativa sendo o único admin',
  $$update public.profiles set is_active=false where id='00000000-0000-0000-0000-00000000000a'$$, 'P0001');
select test.fails('admin NÃO altera e-mail via API', $$update public.profiles set email='novo@x.com' where id='00000000-0000-0000-0000-00000000000c'$$, '42501');
select test.fails('admin NÃO insere perfil via API', $$insert into public.profiles(id,email) values (gen_random_uuid(),'z@z.com')$$, '42501');
select test.fails('admin NÃO exclui perfil via API', $$delete from public.profiles where id='00000000-0000-0000-0000-00000000000c'$$, '42501');
select test.ok('admin desativa Diego', $$update public.profiles set is_active=false where id='00000000-0000-0000-0000-00000000000d'$$);
select test.ok('admin marca reset de senha (must_change_password=true)', $$update public.profiles set must_change_password=true where id='00000000-0000-0000-0000-00000000000c'$$);

-- ---------------------------------------------------------------- INATIVO (Diego)
select test.as_user('00000000-0000-0000-0000-00000000000d');
select test.rows('inativo NÃO vê tarefas', 'select * from public.tasks', 0);
select test.rows('inativo vê só o próprio perfil', 'select * from public.profiles', 1);
select test.fails('inativo NÃO cria tarefa', $$insert into public.tasks(title) values ('x')$$, '42501');
select test.rows('inativo NÃO altera nada', $$update public.tasks set title='x' returning 1$$, 0);
select test.rows('inativo NÃO se reativa (RLS: 0 linhas)', $$update public.profiles set is_active=true where id='00000000-0000-0000-0000-00000000000d' returning 1$$, 0);

-- ---------------------------------------------------------------- SERVICE ROLE (Edge Function)
select test.as_service();
select test.ok('service_role atualiza papel/flag (Edge Function)', $$update public.profiles set role='member', must_change_password=true where id='00000000-0000-0000-0000-00000000000d'$$);

-- ---------------------------------------------------------------- Carla limpa a flag depois de trocar a senha
select test.as_user('00000000-0000-0000-0000-00000000000c');
select test.ok('membro limpa must_change_password após trocar senha', $$update public.profiles set must_change_password=false where id='00000000-0000-0000-0000-00000000000c'$$);

-- ---------------------------------------------------------------- INFRA
select test.as_super();
update auth.users set email='carla.nova@x.com' where id='00000000-0000-0000-0000-00000000000c';
select test.eq('e-mail do Auth sincroniza no perfil', (select email from public.profiles where id='00000000-0000-0000-0000-00000000000c'), 'carla.nova@x.com');

select test.ok('excluir usuário do Auth não é bloqueado pelos triggers',
  $$delete from auth.users where id='00000000-0000-0000-0000-00000000000c'$$);
select test.eq('perfil removido em cascata', (select count(*)::text from public.profiles where id='00000000-0000-0000-0000-00000000000c'), '0');
select test.eq('tarefas dele continuam, autor vira NULL', (select count(*)::text from public.tasks where id='10000000-0000-0000-0000-000000000001' and created_by is null and assignee_id is null), '1');

select test.eq('tasks está na publicação realtime', (select count(*)::text from pg_publication_tables where pubname='supabase_realtime' and tablename='tasks'), '1');
select test.eq('profiles está na publicação realtime', (select count(*)::text from pg_publication_tables where pubname='supabase_realtime' and tablename='profiles'), '1');
select test.eq('RLS ligado em tasks e profiles', (select count(*)::text from pg_class where relname in ('tasks','profiles') and relnamespace='public'::regnamespace and relrowsecurity), '2');

-- ---------------------------------------------------------------- resumo
\echo
\echo ===== RESULTADOS =====
select case when ok then 'PASS' else 'FAIL' end as r, label, case when ok then '' else detail end as detalhe from test.results order by n;
select count(*) filter (where ok) as passaram, count(*) filter (where not ok) as falharam, count(*) as total from test.results;
