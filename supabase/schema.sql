-- ============================================
-- คลังแก้ไฟ กฟส.คำชะอี — Supabase (ย้ายจาก Code.gs v3.1)
-- ตาราง/คอลัมน์ตรงกับชีต stock, truck, logs · inv_post(d) = doPost เดิม
-- ============================================

create table if not exists stock (
  id   bigserial primary key,          -- ลำดับแถวเหมือนในชีต
  code bigint not null unique,
  name text not null default '',
  qty  numeric not null default 0,
  unit text not null default '',
  cat  text not null default ''
);

create table if not exists truck (
  id   bigserial primary key,
  code bigint not null unique,
  name text not null default '',
  qty  numeric not null default 0,
  unit text not null default '',
  cat  text not null default ''
);

create table if not exists logs (
  id          bigserial primary key,
  type        text not null default '',
  code        bigint,
  name        text not null default '',
  qty         numeric not null default 0,
  unit        text not null default '',
  shift       text not null default '',
  location    text not null default '',
  "timestamp" text not null default '',
  lat         text not null default '',
  lng         text not null default '',
  "jobId"     text not null default '',
  note        text not null default '',
  "openedAt"  text not null default ''
);
create index if not exists logs_jobid on logs ("jobId");

-- หน้าเว็บอ่านได้อย่างเดียว · เขียนผ่าน inv_post เท่านั้น
alter table stock enable row level security;
alter table truck enable row level security;
alter table logs  enable row level security;
drop policy if exists read_all on stock; create policy read_all on stock for select using (true);
drop policy if exists read_all on truck; create policy read_all on truck for select using (true);
drop policy if exists read_all on logs;  create policy read_all on logs  for select using (true);
revoke insert, update, delete, truncate on stock, truck, logs from anon, authenticated;
grant select on stock, truck, logs to anon, authenticated;

-- nowTH() เดิม: 'dd/mm/2569 hh:mm'
create or replace function inv_now() returns text language sql stable as $$
  select to_char(t, 'DD/MM/') || (extract(year from t)::int + 543) || to_char(t, ' HH24:MI')
  from (select now() at time zone 'Asia/Bangkok' as t) s $$;

-- ชีตแปลง nowTH() เป็นวันที่ แล้ว GAS ส่งกลับเป็น '2569-10-19T02:44:00.000Z' → เก็บรูปแบบเดียวกัน หน้าเว็บจะได้เหมือนเดิม
create or replace function inv_ts() returns text language sql stable as $$
  select (extract(year from t)::int + 543)::text || to_char(t, '-MM-DD"T"HH24:MI":00.000Z"')
  from (select now() at time zone 'UTC' as t) s $$;

create or replace function inv_post(d jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_act  text := d->>'action';
  v_code bigint := (d->>'code')::bigint;
  v_qty  numeric; v_cur numeric; v_cur2 numeric;
  v_item jsonb; v_results jsonb := '[]'::jsonb;
  v_ts   text := inv_ts();
  v_id   text; v_note text; v_n int; v_lid bigint;
begin
  -- ponytail: ล็อกทั้งระบบทีละคำขอ (คนใช้ไม่กี่คน) — ถ้าคนใช้เยอะค่อยเปลี่ยนเป็นล็อกรายแถว
  perform pg_advisory_xact_lock(42);

  if v_act = 'withdraw' then
    v_qty := (d->>'qty')::numeric;
    select s.qty into v_cur from stock s where s.code = v_code;
    if not found then return jsonb_build_object('error', 'ไม่พบรหัส ' || (d->>'code')); end if;
    if v_cur < v_qty then return jsonb_build_object('error', 'ของในคลังไม่พอ เหลือ ' || v_cur); end if;
    update stock s set qty = v_cur - v_qty where s.code = v_code;
    update truck t set qty = t.qty + v_qty where t.code = v_code;
    if not found then
      insert into truck (code, name, qty, unit, cat)
      values (v_code, coalesce(d->>'name',''), v_qty, coalesce(d->>'unit',''), coalesce(d->>'cat',''));
    end if;
    insert into logs (type, code, name, qty, unit, shift, location, "timestamp")
    values ('เบิกของ', v_code, coalesce(d->>'name',''), v_qty, coalesce(d->>'unit',''), coalesce(d->>'shift',''), 'เบิกเข้ารถ', v_ts);
    return jsonb_build_object('success', true);

  elsif v_act = 'useItem' then
    v_id := 'JOB-' || (extract(epoch from clock_timestamp()) * 1000)::bigint;
    for v_item in select * from jsonb_array_elements(d->'items') loop
      v_qty := (v_item->>'qty')::numeric;
      select t.qty into v_cur from truck t where t.code = (v_item->>'code')::bigint;
      if not found then v_results := v_results || jsonb_build_object('error', 'ไม่พบรหัส ' || (v_item->>'code')); continue; end if;
      if v_cur < v_qty then v_results := v_results || jsonb_build_object('error', 'ของบนรถไม่พอ: ' || (v_item->>'name') || ' เหลือ ' || v_cur); continue; end if;
      update truck t set qty = v_cur - v_qty where t.code = (v_item->>'code')::bigint;
      insert into logs (type, code, name, qty, unit, shift, location, "timestamp", lat, lng, "jobId", note)
      values ('งานแก้ไฟ', (v_item->>'code')::bigint, coalesce(v_item->>'name',''), v_qty, coalesce(v_item->>'unit',''),
              coalesce(d->>'shift',''), coalesce(d->>'location',''), v_ts,
              coalesce(d->>'lat',''), coalesce(d->>'lng',''), v_id, coalesce(d->>'note',''));
      v_results := v_results || jsonb_build_object('success', true, 'code', v_item->'code', 'truckQty', v_cur - v_qty);
    end loop;
    return jsonb_build_object('results', v_results, 'jobId', v_id);

  elsif v_act = 'returnItem' then
    v_qty := (d->>'qty')::numeric;
    select t.qty into v_cur from truck t where t.code = v_code;
    if not found then return jsonb_build_object('error', 'ไม่พบรหัส ' || (d->>'code')); end if;
    if v_cur < v_qty then return jsonb_build_object('error', 'ของบนรถไม่พอ เหลือ ' || v_cur); end if;
    update truck t set qty = v_cur - v_qty where t.code = v_code;
    select s.qty into v_cur2 from stock s where s.code = v_code;
    if found then update stock s set qty = v_cur2 + v_qty where s.code = v_code; else v_cur2 := 0; end if;
    insert into logs (type, code, name, qty, unit, shift, location, "timestamp")
    values ('คืนของ', v_code, coalesce(d->>'name',''), v_qty, coalesce(d->>'unit',''), coalesce(d->>'shift',''), 'คืนจากรถ→คลัง', v_ts);
    return jsonb_build_object('success', true, 'truckQty', v_cur - v_qty, 'stockQty', v_cur2 + v_qty);

  elsif v_act = 'transfer' then
    if jsonb_array_length(coalesce(d->'items','[]')) = 0 then return jsonb_build_object('error', 'ไม่มีรายการพัสดุ'); end if;
    v_id := 'TF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint;
    v_note := concat_ws(' | ',
      case when coalesce(d->>'receiver','') <> '' then 'ผู้รับ: ' || (d->>'receiver') end,
      case when coalesce(d->>'docNo','') <> '' then 'เลขเอกสาร: ' || (d->>'docNo') end,
      nullif(d->>'note',''));
    for v_item in select * from jsonb_array_elements(d->'items') loop
      v_qty := (v_item->>'qty')::numeric;
      select s.qty into v_cur from stock s where s.code = (v_item->>'code')::bigint;
      if not found then v_results := v_results || jsonb_build_object('error', 'ไม่พบรหัส ' || (v_item->>'code')); continue; end if;
      if v_cur < v_qty then v_results := v_results || jsonb_build_object('error', 'ของในคลังไม่พอ: ' || (v_item->>'name') || ' เหลือ ' || v_cur); continue; end if;
      update stock s set qty = v_cur - v_qty where s.code = (v_item->>'code')::bigint;
      insert into logs (type, code, name, qty, unit, location, "timestamp", "jobId", note)
      values ('โอนพัสดุ', (v_item->>'code')::bigint, coalesce(v_item->>'name',''), v_qty, coalesce(v_item->>'unit',''),
              coalesce(d->>'dest',''), v_ts, v_id, v_note);
      v_results := v_results || jsonb_build_object('success', true, 'code', v_item->'code', 'stockQty', v_cur - v_qty);
    end loop;
    return jsonb_build_object('results', v_results, 'transferId', v_id);

  elsif v_act = 'deleteJob' then
    update truck t set qty = t.qty + x.q
    from (select l.code, sum(l.qty) q from logs l where l."jobId" = d->>'jobId' group by l.code) x
    where t.code = x.code;
    delete from logs l where l."jobId" = d->>'jobId';
    get diagnostics v_n = row_count;
    return jsonb_build_object('success', true, 'deleted', v_n);

  elsif v_act = 'updateStock' then
    update stock s set qty = (d->>'qty')::numeric,
                       unit = case when coalesce(d->>'unit','') <> '' then d->>'unit' else s.unit end
    where s.code = v_code;
    if not found then return jsonb_build_object('error', 'ไม่พบรหัส ' || (d->>'code')); end if;
    if coalesce(d->>'unit','') <> '' then update truck t set unit = d->>'unit' where t.code = v_code; end if;
    return jsonb_build_object('success', true);

  elsif v_act = 'addItem' then
    if exists (select 1 from stock s where s.code = v_code) then
      return jsonb_build_object('error', 'รหัส ' || (d->>'code') || ' มีอยู่แล้ว');
    end if;
    insert into stock (code, name, qty, unit, cat)
    values (v_code, coalesce(d->>'name',''), coalesce((d->>'qty')::numeric, 0), coalesce(d->>'unit',''), coalesce(d->>'cat',''));
    insert into truck (code, name, qty, unit, cat)
    values (v_code, coalesce(d->>'name',''), 0, coalesce(d->>'unit',''), coalesce(d->>'cat',''))
    on conflict (code) do nothing;
    return jsonb_build_object('success', true);

  elsif v_act = 'updateJobItem' then
    v_qty := (d->>'newQty')::numeric - (d->>'oldQty')::numeric;   -- diff
    select l.id into v_lid from logs l where l."jobId" = d->>'jobId' and l.code = v_code order by l.id limit 1;
    if not found then return jsonb_build_object('error', 'ไม่พบรายการใน logs: ' || (d->>'jobId') || ' / ' || (d->>'code')); end if;
    update logs l set qty = (d->>'newQty')::numeric where l.id = v_lid;
    if v_qty <> 0 then update truck t set qty = greatest(0, t.qty - v_qty) where t.code = v_code; end if;
    return jsonb_build_object('success', true, 'updated', 1, 'diff', v_qty);

  elsif v_act = 'addJobItem' then
    v_qty := (d->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then return jsonb_build_object('error', 'จำนวนไม่ถูกต้อง'); end if;
    select t.qty into v_cur from truck t where t.code = v_code;
    if not found then return jsonb_build_object('error', 'ไม่พบรหัส ' || (d->>'code') || ' บนรถ'); end if;
    if v_cur < v_qty then return jsonb_build_object('error', 'ของบนรถไม่พอ: ' || (d->>'name') || ' เหลือ ' || v_cur); end if;
    update truck t set qty = v_cur - v_qty where t.code = v_code;
    select l.id, l.qty into v_lid, v_cur2 from logs l where l."jobId" = d->>'jobId' and l.code = v_code order by l.id limit 1;
    if found then
      update logs l set qty = v_cur2 + v_qty where l.id = v_lid;
      return jsonb_build_object('success', true, 'truckQty', v_cur - v_qty, 'merged', true, 'newQty', v_cur2 + v_qty);
    end if;
    insert into logs (type, code, name, qty, unit, shift, location, "timestamp", lat, lng, "jobId", note, "openedAt")
    values ('งานแก้ไฟ', v_code, coalesce(d->>'name',''), v_qty, coalesce(d->>'unit',''),
            coalesce(d->>'shift',''), coalesce(d->>'location',''), v_ts,
            coalesce(d->>'lat',''), coalesce(d->>'lng',''), d->>'jobId', coalesce(d->>'note',''), coalesce(d->>'openedAt',''));
    return jsonb_build_object('success', true, 'truckQty', v_cur - v_qty, 'merged', false);

  elsif v_act = 'toggleJobOpened' then
    update logs l set "openedAt" = case when (d->>'opened')::boolean then v_ts else '' end where l."jobId" = d->>'jobId';
    if not found then return jsonb_build_object('error', 'ไม่พบใบงาน ' || (d->>'jobId')); end if;
    return jsonb_build_object('success', true, 'openedAt', case when (d->>'opened')::boolean then inv_now() else '' end);
  end if;

  -- ponytail: returnJob ใน Code.gs ไม่มีหน้าเว็บเรียกใช้ จึงไม่ย้ายมา
  return jsonb_build_object('error', 'Unknown action: ' || coalesce(v_act, ''));
end $$;

revoke execute on function inv_post(jsonb) from public;
grant execute on function inv_post(jsonb) to anon, authenticated;
