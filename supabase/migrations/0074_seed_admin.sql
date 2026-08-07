-- Migration: 0074_seed_admin.sql
-- Goal: Seed teamocsph@gmail.com into public.platform_admins as super_admin

insert into public.platform_admins (user_id, role, is_active)
select u.id, 'super_admin', true
  from auth.users u
 where lower(u.email) = 'teamocsph@gmail.com'
on conflict (user_id) do update
  set role = 'super_admin',
      is_active = true;
