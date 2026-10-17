require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'ironvault',
  ssl: process.env.DB_HOST
    ? { rejectUnauthorized: false }
    : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+00:00',
  decimalNumbers: true
});

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));

const sessionStore = new MySQLStore({}, pool);
app.use(session({
  name: 'ironvault.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: 'Please log in.' });
  next();
}
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')); }
function moneyToPaise(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) throw new Error('Invalid amount.');
  return Math.round(n * 100);
}
function addMonths(dateStr, months) {
  const [y,m,d] = dateStr.split('-').map(Number);
  const targetMonth = m - 1 + months;
  const targetYear = y + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const last = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return `${targetYear}-${String(month + 1).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function expiryAfterMonths(startDate, months) {
  // The end date is inclusive, so a one-month plan starting on the 16th ends on the 15th next month.
  return addDays(addMonths(startDate, months), -1);
}
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function statusFor(start, expiry, today = todayLocal()) {
  if (start > today) return 'UPCOMING';
  if (expiry < today) return 'EXPIRED';
  const t = new Date(today + 'T00:00:00Z').getTime();
  const e = new Date(expiry + 'T00:00:00Z').getTime();
  return Math.round((e - t) / 86400000) <= 6 ? 'EXPIRING SOON' : 'ACTIVE';
}
async function audit(req, action, type, id, details = {}) {
  await pool.execute(
    'INSERT INTO audit_logs (admin_id,action,entity_type,entity_id,details_json,ip_address) VALUES (?,?,?,?,?,?)',
    [req.session.admin?.id || null, action, type, String(id ?? ''), JSON.stringify(details), req.ip]
  );
}
async function latestMembership(memberId) {
  const [rows] = await pool.execute(
    `SELECT m.*, p.name AS current_plan_name
     FROM memberships m LEFT JOIN membership_plans p ON p.id=m.plan_id
     WHERE m.member_id=? ORDER BY m.expiry_date DESC, m.id DESC LIMIT 1`, [memberId]
  );
  return rows[0] || null;
}
async function memberView(row) {
  const membership = await latestMembership(row.id);
  return { ...row, membership, membership_status: membership ? statusFor(membership.start_date.toISOString?.().slice(0,10) || String(membership.start_date).slice(0,10), membership.expiry_date.toISOString?.().slice(0,10) || String(membership.expiry_date).slice(0,10)) : 'NO MEMBERSHIP' };
}
function dateOnly(v) { return v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10); }

app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS test');
    res.json({
      ok: true,
      database: 'connected',
      test: rows[0].test
    });
  } catch (err) {
    console.error('DB diagnostic:', {
      name: err.name,
      message: err.message,
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState
    });

    res.status(503).json({
      ok: false,
      database: 'unavailable',
      error: err.code || err.name
    });
  }
});

app.get('/api/plans', async (req,res) => {
  const [rows] = await pool.query('SELECT id,name,duration_months,price_paise,description,features_json FROM membership_plans WHERE active=1 ORDER BY price_paise');
  res.json(rows.map(p => ({...p, price: p.price_paise/100, features: p.features_json || []})));
});

app.post('/api/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 8 }), async (req,res) => {
  const { fullName, mobile, email, age, gender, planId, preferredProgram, startDate } = req.body || {};
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.trim().length > 160) return res.status(400).json({error:'Enter your full name.'});
  if (typeof mobile !== 'string' || !/^[6-9]\d{9}$/.test(mobile.trim())) return res.status(400).json({error:'Enter a valid 10-digit Indian mobile number.'});
  if (email && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({error:'Enter a valid email address.'});
  if (!validDate(startDate) || startDate < todayLocal()) return res.status(400).json({error:'Choose today or a future membership start date.'});
  const ageNum = age === '' || age == null ? null : Number(age);
  if (ageNum != null && (!Number.isInteger(ageNum) || ageNum < 16 || ageNum > 100)) return res.status(400).json({error:'Age must be between 16 and 100.'});
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [plans] = await conn.execute('SELECT * FROM membership_plans WHERE id=? AND active=1', [Number(planId)]);
    if (!plans.length) { await conn.rollback(); return res.status(400).json({error:'Choose a valid membership plan.'}); }
    const plan = plans[0];
    const [existing] = await conn.execute('SELECT id FROM members WHERE mobile=? AND archived=0', [mobile.trim()]);
    if (existing.length) { await conn.rollback(); return res.status(409).json({error:'A member with this mobile number already exists. Please contact the gym.'}); }
    const memberCode = 'IV-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
    const [ins] = await conn.execute(
      'INSERT INTO members (member_code,full_name,mobile,email,age,gender,preferred_program,joined_on) VALUES (?,?,?,?,?,?,?,?)',
      [memberCode, fullName.trim(), mobile.trim(), email?.trim() || null, ageNum, gender || null, preferredProgram || null, todayLocal()]
    );
    const expiry = expiryAfterMonths(startDate, Number(plan.duration_months));
    const [m] = await conn.execute(
      'INSERT INTO memberships (member_id,plan_id,plan_name_snapshot,duration_months,fee_paise,start_date,expiry_date) VALUES (?,?,?,?,?,?,?)',
      [ins.insertId, plan.id, plan.name, plan.duration_months, plan.price_paise, startDate, expiry]
    );
    const [inv] = await conn.execute(
      'INSERT INTO invoices (member_id,membership_id,amount_paise,due_date,status,description) VALUES (?,?,?,?,?,?)',
      [ins.insertId, m.insertId, plan.price_paise, startDate, 'pending', `${plan.name} membership`]
    );
    await conn.commit();
    res.status(201).json({message:'Registration received. The gym team will confirm your membership and payment.', memberCode, invoiceId:inv.insertId});
  } catch (e) { await conn.rollback(); console.error(e); res.status(500).json({error:'Registration could not be saved. Please try again.'}); }
  finally { conn.release(); }
});


app.post('/api/contact', rateLimit({ windowMs: 60 * 60 * 1000, limit: 8 }), async (req,res) => {
  const { name, email, phone='', message } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120) return res.status(400).json({error:'Enter your name.'});
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({error:'Enter a valid email.'});
  if (typeof message !== 'string' || message.trim().length < 5 || message.length > 2000) return res.status(400).json({error:'Enter a message between 5 and 2000 characters.'});
  try {
    const [result] = await pool.execute('INSERT INTO contact_enquiries (name,email,phone,message) VALUES (?,?,?,?)', [name.trim(),email.toLowerCase().trim(),String(phone||'').slice(0,20)||null,message.trim()]);
    return res.status(201).json({ok:true,id:result.insertId,message:'Enquiry saved. The gym team can follow up.'});
  } catch (e) {
    console.error(e);
    return res.status(500).json({error:'Could not save the enquiry. Please try again later.'});
  }
});

app.post('/api/auth/login', async (req,res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({error:'Email and password are required.'});
  const [rows] = await pool.execute('SELECT id,name,email,password_hash FROM admins WHERE email=? LIMIT 1', [email.toLowerCase().trim()]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({error:'Invalid email or password.'});
  req.session.regenerate(err => {
    if (err) return res.status(500).json({error:'Could not start a secure session.'});
    req.session.admin = { id: rows[0].id, name: rows[0].name, email: rows[0].email };
    res.json({admin:req.session.admin});
  });
});
app.get('/api/auth/me', (req,res) => req.session.admin ? res.json({admin:req.session.admin}) : res.status(401).json({error:'Not logged in.'}));
app.post('/api/auth/logout', (req,res) => req.session.destroy(() => { res.clearCookie('ironvault.sid'); res.json({ok:true}); }));

app.get('/api/dashboard', requireAdmin, async (req,res) => {
  const today = todayLocal();
  const [memberRows] = await pool.query('SELECT id,full_name,mobile,email,member_code,archived FROM members WHERE archived=0');
  const [memberships] = await pool.query(`SELECT ms.*, m.full_name,m.mobile,m.member_code FROM memberships ms JOIN members m ON m.id=ms.member_id WHERE m.archived=0`);
  const computed = memberships.map(m => ({...m, start_date:dateOnly(m.start_date), expiry_date:dateOnly(m.expiry_date), status:statusFor(dateOnly(m.start_date),dateOnly(m.expiry_date),today)}));
  const latest = new Map();
  for (const m of computed) if (!latest.has(m.member_id) || m.expiry_date > latest.get(m.member_id).expiry_date) latest.set(m.member_id,m);
  const current = [...latest.values()];
  const [pay] = await pool.query(`SELECT COALESCE(SUM(p.amount_paise),0) AS collected FROM payments p`);
  const [out] = await pool.query(`SELECT COALESCE(SUM(i.amount_paise - COALESCE(x.paid,0)),0) AS outstanding
    FROM invoices i LEFT JOIN (SELECT invoice_id,SUM(amount_paise) paid FROM payments GROUP BY invoice_id) x ON x.invoice_id=i.id
    WHERE i.status NOT IN ('cancelled','paid')`);
  const [newToday] = await pool.execute('SELECT COUNT(*) n FROM members WHERE DATE(created_at)=? AND archived=0',[today]);
  const [pending] = await pool.query(`SELECT COUNT(*) n FROM invoices i LEFT JOIN (SELECT invoice_id,SUM(amount_paise) paid FROM payments GROUP BY invoice_id) x ON x.invoice_id=i.id WHERE i.status NOT IN ('cancelled') AND i.amount_paise>COALESCE(x.paid,0)`);
  const [recentPayments] = await pool.query(`SELECT p.id,p.amount_paise/100 amount,p.method,p.paid_at,m.full_name,m.member_code FROM payments p JOIN members m ON m.id=p.member_id ORDER BY p.paid_at DESC LIMIT 8`);
  res.json({
    stats:{
      totalMembers:memberRows.length,
      active:current.filter(m=>m.status==='ACTIVE').length,
      expiring:current.filter(m=>m.status==='EXPIRING SOON').length,
      expired:current.filter(m=>m.status==='EXPIRED').length,
      upcoming:current.filter(m=>m.status==='UPCOMING').length,
      pendingPayments:Number(pending[0].n),
      newToday:Number(newToday[0].n),
      expiringToday:current.filter(m=>m.expiry_date===today).length,
      revenue:Number(pay[0].collected)/100,
      outstanding:Number(out[0].outstanding)/100
    },
    expiringMembers:current.filter(m=>m.status==='EXPIRING SOON'||m.status==='EXPIRED').sort((a,b)=>a.expiry_date.localeCompare(b.expiry_date)).slice(0,12),
    recentPayments
  });
});

app.get('/api/members', requireAdmin, async (req,res) => {
  const search = String(req.query.search || '').trim().slice(0,100);
  const status = String(req.query.status || 'ALL');
  const params = [];
  let where = 'WHERE m.archived=0';
  if (search) { where += ' AND (m.full_name LIKE ? OR m.mobile LIKE ? OR m.member_code LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
  const [rows] = await pool.execute(
    `SELECT m.*, ms.id membership_id,ms.plan_name_snapshot,ms.start_date,ms.expiry_date,ms.fee_paise,ms.duration_months
     FROM members m LEFT JOIN memberships ms ON ms.id=(SELECT id FROM memberships WHERE member_id=m.id ORDER BY expiry_date DESC,id DESC LIMIT 1)
     ${where} ORDER BY m.created_at DESC LIMIT 500`, params
  );
  const result = rows.map(r => ({...r, start_date:r.start_date?dateOnly(r.start_date):null, expiry_date:r.expiry_date?dateOnly(r.expiry_date):null, membership_status:r.membership_id?statusFor(dateOnly(r.start_date),dateOnly(r.expiry_date)):'NO MEMBERSHIP'}));
  res.json(status==='ALL'?result:result.filter(m=>m.membership_status===status));
});

app.post('/api/members', requireAdmin, async (req,res) => {
  const {fullName,mobile,email,age,gender,planId,startDate,preferredProgram} = req.body || {};
  if (typeof fullName!=='string'||fullName.trim().length<2||typeof mobile!=='string'||!/^[6-9]\d{9}$/.test(mobile.trim())) return res.status(400).json({error:'Valid full name and 10-digit Indian mobile are required.'});
  if (!validDate(startDate)) return res.status(400).json({error:'Valid start date is required.'});
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [plans]=await conn.execute('SELECT * FROM membership_plans WHERE id=? AND active=1',[Number(planId)]);
    if(!plans.length){await conn.rollback();return res.status(400).json({error:'Invalid plan.'});}
    const p=plans[0];
    const [ins]=await conn.execute('INSERT INTO members (member_code,full_name,mobile,email,age,gender,preferred_program,joined_on) VALUES (?,?,?,?,?,?,?,?)',
      ['IV-'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,5).toUpperCase(),fullName.trim(),mobile.trim(),email||null,age?Number(age):null,gender||null,preferredProgram||null,todayLocal()]);
    const expiry=expiryAfterMonths(startDate,p.duration_months);
    const [ms]=await conn.execute('INSERT INTO memberships (member_id,plan_id,plan_name_snapshot,duration_months,fee_paise,start_date,expiry_date) VALUES (?,?,?,?,?,?,?)',[ins.insertId,p.id,p.name,p.duration_months,p.price_paise,startDate,expiry]);
    await conn.execute('INSERT INTO invoices (member_id,membership_id,amount_paise,due_date,status,description) VALUES (?,?,?,?,?,?)',[ins.insertId,ms.insertId,p.price_paise,startDate,'pending',`${p.name} membership`]);
    await conn.commit(); await audit(req,'member.created','member',ins.insertId);
    res.status(201).json({id:ins.insertId,memberCode:'Created',message:'Member added.'});
  } catch(e){await conn.rollback();if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'That mobile number already exists.'});console.error(e);res.status(500).json({error:'Could not add member.'});}
  finally{conn.release();}
});

app.get('/api/members/:id', requireAdmin, async (req,res) => {
  const [rows]=await pool.execute('SELECT * FROM members WHERE id=? AND archived=0',[req.params.id]);
  if(!rows.length)return res.status(404).json({error:'Member not found.'});
  const [ms]=await pool.execute('SELECT * FROM memberships WHERE member_id=? ORDER BY created_at DESC',[req.params.id]);
  const [invoices]=await pool.execute(`SELECT i.*,COALESCE(p.paid,0) paid_paise FROM invoices i LEFT JOIN (SELECT invoice_id,SUM(amount_paise) paid FROM payments GROUP BY invoice_id) p ON p.invoice_id=i.id WHERE i.member_id=? ORDER BY i.created_at DESC`,[req.params.id]);
  const [followups]=await pool.execute('SELECT * FROM follow_ups WHERE member_id=? ORDER BY created_at DESC',[req.params.id]);
  res.json({member:rows[0],memberships:ms.map(m=>({...m,start_date:dateOnly(m.start_date),expiry_date:dateOnly(m.expiry_date),status:statusFor(dateOnly(m.start_date),dateOnly(m.expiry_date))})),invoices:invoices.map(i=>({...i,due_date:dateOnly(i.due_date),amount:i.amount_paise/100,paid:i.paid_paise/100,balance:Math.max(0,i.amount_paise-i.paid_paise)/100})),followups});
});

app.put('/api/members/:id', requireAdmin, async (req,res) => {
  const {fullName,mobile,email,age,gender,preferredProgram}=req.body||{};
  if(typeof fullName!=='string'||fullName.trim().length<2||typeof mobile!=='string'||!/^[6-9]\d{9}$/.test(mobile.trim()))return res.status(400).json({error:'Valid name and mobile are required.'});
  try {
    await pool.execute('UPDATE members SET full_name=?,mobile=?,email=?,age=?,gender=?,preferred_program=? WHERE id=? AND archived=0',[fullName.trim(),mobile.trim(),email||null,age?Number(age):null,gender||null,preferredProgram||null,req.params.id]);
    await audit(req,'member.updated','member',req.params.id);
    res.json({ok:true});
  } catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'Mobile number already belongs to another member.'});res.status(500).json({error:'Could not update member.'});}
});
app.delete('/api/members/:id', requireAdmin, async (req,res) => {
  await pool.execute('UPDATE members SET archived=1 WHERE id=?',[req.params.id]);
  await audit(req,'member.archived','member',req.params.id);
  res.json({ok:true,message:'Member archived; historical records retained.'});
});

app.put('/api/plans/:id', requireAdmin, async (req,res) => {
  const price = moneyToPaise(req.body.price);
  const active = req.body.active === false ? 0 : 1;
  const [r] = await pool.execute('UPDATE membership_plans SET price_paise=?,active=? WHERE id=?',[price,active,req.params.id]);
  if(!r.affectedRows)return res.status(404).json({error:'Plan not found.'});
  await audit(req,'plan.updated','plan',req.params.id,{price});
  res.json({ok:true});
});

app.post('/api/members/:id/renew', requireAdmin, async (req,res) => {
  const {planId,startDate,paymentAmount,paymentMethod='cash'}=req.body||{};
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [member]=await conn.execute('SELECT * FROM members WHERE id=? AND archived=0 FOR UPDATE',[req.params.id]);
    if(!member.length){await conn.rollback();return res.status(404).json({error:'Member not found.'});}
    const [plans]=await conn.execute('SELECT * FROM membership_plans WHERE id=? AND active=1',[Number(planId)]);
    if(!plans.length){await conn.rollback();return res.status(400).json({error:'Select a valid plan.'});}
    const plan=plans[0];
    const [old]=await conn.execute('SELECT * FROM memberships WHERE member_id=? ORDER BY expiry_date DESC,id DESC LIMIT 1 FOR UPDATE',[req.params.id]);
    let start = validDate(startDate) ? startDate : todayLocal();
    if(old.length && old[0].expiry_date) {
      const oldExpiry=dateOnly(old[0].expiry_date);
      if(oldExpiry >= todayLocal() && oldExpiry >= start) start=addDays(oldExpiry,1); // extend the day after the inclusive expiry date
      else start=todayLocal();
    }
    const expiry=expiryAfterMonths(start,Number(plan.duration_months));
    const [ms]=await conn.execute('INSERT INTO memberships (member_id,plan_id,plan_name_snapshot,duration_months,fee_paise,start_date,expiry_date) VALUES (?,?,?,?,?,?,?)',[req.params.id,plan.id,plan.name,plan.duration_months,plan.price_paise,start,expiry]);
    const [inv]=await conn.execute('INSERT INTO invoices (member_id,membership_id,amount_paise,due_date,status,description) VALUES (?,?,?,?,?,?)',[req.params.id,ms.insertId,plan.price_paise,todayLocal(),'pending',`${plan.name} renewal`]);
    const amount=moneyToPaise(paymentAmount||0);
    if(amount>0) {
      if(amount>plan.price_paise){await conn.rollback();return res.status(400).json({error:'Payment cannot exceed the renewal fee.'});}
      await conn.execute('INSERT INTO payments (invoice_id,member_id,amount_paise,method,recorded_by) VALUES (?,?,?,?,?)',[inv.insertId,req.params.id,amount,paymentMethod,req.session.admin.id]);
      if(amount===plan.price_paise)await conn.execute('UPDATE invoices SET status="paid" WHERE id=?',[inv.insertId]);
    }
    await conn.commit(); await audit(req,'membership.renewed','member',req.params.id,{plan:plan.name,expiry});
    res.status(201).json({ok:true,startDate:start,expiryDate:expiry,message:'Membership renewed.'});
  } catch(e){await conn.rollback();console.error(e);res.status(500).json({error:'Renewal failed.'});}
  finally{conn.release();}
});

app.post('/api/invoices/:id/payments', requireAdmin, async (req,res) => {
  const {amount,method='cash',reference='',note=''}=req.body||{};
  let paise; try { paise=moneyToPaise(amount); } catch { return res.status(400).json({error:'Enter a valid payment amount.'}); }
  if(paise<=0)return res.status(400).json({error:'Payment must be greater than zero.'});
  if(!['cash','upi','card','bank_transfer','other'].includes(method))return res.status(400).json({error:'Invalid payment method.'});
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [inv]=await conn.execute('SELECT * FROM invoices WHERE id=? FOR UPDATE',[req.params.id]);
    if(!inv.length){await conn.rollback();return res.status(404).json({error:'Invoice not found.'});}
    const [paid]=await conn.execute('SELECT COALESCE(SUM(amount_paise),0) total FROM payments WHERE invoice_id=?',[req.params.id]);
    const remaining=Number(inv[0].amount_paise)-Number(paid[0].total);
    if(paise>remaining){await conn.rollback();return res.status(400).json({error:'Payment exceeds remaining balance.'});}
    await conn.execute('INSERT INTO payments (invoice_id,member_id,amount_paise,method,reference,recorded_by,note) VALUES (?,?,?,?,?,?,?)',[req.params.id,inv[0].member_id,paise,method,reference||null,req.session.admin.id,note||null]);
    const next=remaining-paise===0?'paid':(dateOnly(inv[0].due_date)<todayLocal()?'overdue':'pending');
    await conn.execute('UPDATE invoices SET status=? WHERE id=?',[next,req.params.id]);
    await conn.commit(); await audit(req,'payment.recorded','invoice',req.params.id,{amount:paise/100,method});
    res.status(201).json({ok:true,remaining:(remaining-paise)/100,status:next});
  } catch(e){await conn.rollback();console.error(e);res.status(500).json({error:'Payment could not be recorded.'});}
  finally{conn.release();}
});

app.post('/api/members/:id/follow-ups', requireAdmin, async (req,res) => {
  const {note='',status='pending',nextFollowUp=null}=req.body||{};
  if(!['pending','contacted','completed'].includes(status))return res.status(400).json({error:'Invalid follow-up status.'});
  if(nextFollowUp && !validDate(nextFollowUp))return res.status(400).json({error:'Invalid follow-up date.'});
  const [r]=await pool.execute('INSERT INTO follow_ups (member_id,note,status,next_follow_up,created_by) VALUES (?,?,?,?,?)',[req.params.id,String(note).slice(0,1000),status,nextFollowUp,req.session.admin.id]);
  await audit(req,'followup.created','member',req.params.id,{status});
  res.status(201).json({id:r.insertId});
});

app.get('/api/enquiries', requireAdmin, async (req,res) => {
  const [rows] = await pool.query('SELECT id,name,email,phone,message,status,created_at FROM contact_enquiries ORDER BY created_at DESC LIMIT 300');
  res.json(rows);
});
app.put('/api/enquiries/:id', requireAdmin, async (req,res) => {
  const status = req.body.status;
  if (!['new','contacted','closed'].includes(status)) return res.status(400).json({error:'Invalid enquiry status.'});
  const [result] = await pool.execute('UPDATE contact_enquiries SET status=? WHERE id=?',[status,req.params.id]);
  if (!result.affectedRows) return res.status(404).json({error:'Enquiry not found.'});
  await audit(req,'enquiry.updated','enquiry',req.params.id,{status});
  res.json({ok:true});
});

// Membership-expiry worklist. This is a live view of current member records,
// not a message queue; it does not send WhatsApp/SMS/email messages.
app.get('/api/reminders', requireAdmin, async (req,res) => {
  const today = todayLocal();
  const [rows] = await pool.query(`
    SELECT m.id AS member_id, m.member_code, m.full_name, m.mobile, m.email,
           ms.id AS membership_id, ms.plan_name_snapshot, ms.start_date, ms.expiry_date
    FROM members m
    JOIN memberships ms ON ms.id = (
      SELECT m2.id FROM memberships m2
      WHERE m2.member_id = m.id
      ORDER BY m2.expiry_date DESC, m2.id DESC LIMIT 1
    )
    WHERE m.archived = 0
    ORDER BY ms.expiry_date ASC, m.full_name ASC
  `);
  const todayTime = new Date(today + 'T00:00:00Z').getTime();
  const members = rows.map(r => {
    const startDate = dateOnly(r.start_date);
    const expiryDate = dateOnly(r.expiry_date);
    const daysRemaining = Math.round((new Date(expiryDate + 'T00:00:00Z').getTime() - todayTime) / 86400000);
    let reminderStatus;
    if (startDate > today) reminderStatus = 'UPCOMING';
    else if (daysRemaining < 0) reminderStatus = 'EXPIRED';
    else if (daysRemaining === 0) reminderStatus = 'EXPIRES TODAY';
    else if (daysRemaining <= 7) reminderStatus = 'EXPIRING SOON';
    else reminderStatus = 'ACTIVE';
    return {...r, start_date:startDate, expiry_date:expiryDate, days_remaining:daysRemaining, reminder_status:reminderStatus};
  });
  const relevant = members.filter(m => ['EXPIRING SOON','EXPIRES TODAY','EXPIRED'].includes(m.reminder_status));
  res.json({
    today,
    counts: {
      expiringSoon: relevant.filter(m => m.reminder_status === 'EXPIRING SOON').length,
      expiresToday: relevant.filter(m => m.reminder_status === 'EXPIRES TODAY').length,
      expired: relevant.filter(m => m.reminder_status === 'EXPIRED').length,
      total: relevant.length
    },
    members: relevant
  });
});

app.get('/api/export/members.csv', requireAdmin, async (req,res) => {
  const [rows]=await pool.query(`SELECT m.member_code,m.full_name,m.mobile,m.email,m.joined_on,ms.plan_name_snapshot,ms.start_date,ms.expiry_date,ms.fee_paise FROM members m LEFT JOIN memberships ms ON ms.id=(SELECT id FROM memberships WHERE member_id=m.id ORDER BY expiry_date DESC,id DESC LIMIT 1) WHERE m.archived=0 ORDER BY m.full_name`);
  const safe = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g,'""') + '"';
  };
  const csv=[['Member ID','Name','Mobile','Email','Joined','Plan','Start','Expiry','Fee INR'],...rows.map(r=>[r.member_code,r.full_name,r.mobile,r.email,dateOnly(r.joined_on),r.plan_name_snapshot,dateOnly(r.start_date),dateOnly(r.expiry_date),(r.fee_paise||0)/100])].map(row=>row.map(safe).join(',')).join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="ironvault-members.csv"');
  res.send('\uFEFF'+csv);
});

app.get('/api/receipt/:invoiceId', requireAdmin, async (req,res) => {
  const [rows]=await pool.execute(`SELECT i.id,i.amount_paise,i.status,i.created_at,m.full_name,m.member_code,COALESCE(SUM(p.amount_paise),0) paid FROM invoices i JOIN members m ON m.id=i.member_id LEFT JOIN payments p ON p.invoice_id=i.id WHERE i.id=? GROUP BY i.id`,[req.params.invoiceId]);
  if(!rows.length)return res.status(404).json({error:'Invoice not found.'});
  res.json({...rows[0],amount:rows[0].amount_paise/100,paid:rows[0].paid/100,balance:(rows[0].amount_paise-rows[0].paid)/100});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:'Unexpected server error.'}); });

const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log(`IronVault running on http://localhost:${port}`));
