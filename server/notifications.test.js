const {test}=require('node:test')
const assert=require('node:assert/strict')
const {DatabaseSync}=require('node:sqlite')
const {createNotifications}=require('./notifications')

function fixture({legacy=false}={}){
  const db=new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE activities(id INTEGER PRIMARY KEY,title TEXT,description TEXT,location TEXT,starts_at INTEGER,ends_at INTEGER,capacity INTEGER,credit_hours REAL,status TEXT DEFAULT 'published');
    CREATE TABLE registrations(activity_id INTEGER,user_id TEXT,registered_at INTEGER,confirmed_at INTEGER,credited_hours REAL DEFAULT 0${legacy?'':',cancelled_at INTEGER'},PRIMARY KEY(activity_id,user_id));
    CREATE TABLE experiences(id INTEGER PRIMARY KEY,user_id TEXT,activity_id INTEGER,title TEXT,status TEXT DEFAULT 'pending',credit_hours REAL DEFAULT 0,review_note TEXT DEFAULT '',reviewed_by TEXT);
    CREATE TABLE external_trainings(id INTEGER PRIMARY KEY,user_id TEXT,title TEXT,status TEXT DEFAULT 'pending',credited_hours REAL DEFAULT 0,review_note TEXT DEFAULT '');
    CREATE TABLE credentials(user_id TEXT PRIMARY KEY,password_hash TEXT,must_change INTEGER);
    INSERT INTO users VALUES('c1','counselor',1),('c2','counselor',1),('off','counselor',0),('a1','admin',1),('a2','admin',1),('admin-off','admin',0);
    INSERT INTO activities VALUES(999,'历史活动','历史','地点',1,2,20,1,'published');`)
  const api=createNotifications(db)
  const users={c1:{id:'c1',role:'counselor'},c2:{id:'c2',role:'counselor'},off:{id:'off',role:'counselor'},a1:{id:'a1',role:'admin'},a2:{id:'a2',role:'admin'}}
  const count=(kind,user)=>db.prepare('SELECT COUNT(*) n FROM notifications WHERE kind=?'+(user?' AND user_id=?':'')).get(...(user?[kind,user]:[kind])).n
  const activity=(id=1,title='培训活动')=>db.prepare("INSERT INTO activities VALUES(?,?,'活动说明','现场',1000,2000,20,1.5,'published')").run(id,title)
  const addRegistration=(user='c1',id=1)=>db.prepare('INSERT INTO registrations(activity_id,user_id,registered_at) VALUES(?,?,100)').run(id,user)
  return {db,api,users,count,activity,addRegistration}
}

test('不补发历史活动，重复初始化无重复；发布只给启用辅导员，修改只给有效报名者',()=>{
  const f=fixture(),{db,api,users,count,activity,addRegistration}=f
  try{
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n,0)
    activity()
    assert.equal(count('activity.published'),2)
    assert.equal(count('activity.published','a1'),0)
    assert.equal(count('activity.published','off'),0)
    createNotifications(db)
    assert.equal(count('activity.published'),2)
    addRegistration('c1');addRegistration('c2')
    db.prepare('UPDATE registrations SET cancelled_at=200 WHERE activity_id=1 AND user_id=?').run('c2')
    db.prepare('UPDATE activities SET location=? WHERE id=1').run('新地点')
    assert.equal(count('activity.changed','c1'),1)
    assert.equal(count('activity.changed','c2'),0)
    db.prepare('UPDATE activities SET location=location WHERE id=1').run()
    assert.equal(count('activity.changed','c1'),1)
    const message=api.list(users.c1,new URL('http://local/api/notifications?limit=20')).rows.find(row=>row.kind==='activity.published')
    assert.equal(api.read(users.c1,message.id).target.url,'/pages/course/detail?id=1')
  }finally{db.close()}
})

test('取消及重新报名各记录一次，取消活动不会让退出人员导航到无权详情',()=>{
  const {db,api,users,count,activity,addRegistration}=fixture()
  try{
    activity();addRegistration('c1')
    db.exec("UPDATE registrations SET cancelled_at=200 WHERE activity_id=1 AND user_id='c1'")
    db.exec("UPDATE registrations SET cancelled_at=200 WHERE activity_id=1 AND user_id='c1'")
    assert.equal(count('registration.cancelled','c1'),1)
    db.exec("UPDATE registrations SET cancelled_at=NULL WHERE activity_id=1 AND user_id='c1'")
    assert.equal(count('registration.registered','c1'),2)
    db.exec("UPDATE registrations SET cancelled_at=300 WHERE activity_id=1 AND user_id='c1'")
    db.exec("UPDATE activities SET status='cancelled' WHERE id=1")
    db.exec("UPDATE activities SET status='cancelled' WHERE id=1")
    assert.equal(count('activity.cancelled','c1'),1)
    const notice=api.list(users.c1,new URL('http://local/api/notifications')).rows.find(row=>row.kind==='activity.cancelled')
    assert.deepEqual(api.read(users.c1,notice.id).target,{url:'/pages/record/record',tab:true})
  }finally{db.close()}
})

test('确认参加及经历审核合并一次结果通知，取消活动不再重复发驳回结果',()=>{
  const {db,count,activity,addRegistration}=fixture()
  try{
    activity();addRegistration('c1')
    db.exec("INSERT INTO experiences(user_id,activity_id,title) VALUES('c1',1,'培训活动')")
    assert.equal(count('review.pending','a1'),1);assert.equal(count('review.pending','a2'),1)
    assert.equal(count('review.pending','admin-off'),0)
    db.exec("BEGIN;UPDATE registrations SET confirmed_at=1000,credited_hours=1.5 WHERE activity_id=1 AND user_id='c1';UPDATE experiences SET status='approved',credit_hours=1.5,reviewed_by='a1' WHERE id=1;COMMIT")
    assert.equal(count('participation.confirmed','c1'),0)
    assert.equal(count('experience.reviewed','c1'),1)
    db.exec("UPDATE experiences SET status='approved' WHERE id=1")
    assert.equal(count('experience.reviewed','c1'),1)
    activity(2,'第二次活动');addRegistration('c2',2)
    db.exec("UPDATE registrations SET confirmed_at=1100,credited_hours=1.5 WHERE activity_id=2 AND user_id='c2'")
    assert.equal(count('participation.confirmed','c2'),1)
    db.exec("INSERT INTO experiences(user_id,activity_id,title) VALUES('c2',2,'第二次活动');UPDATE activities SET status='cancelled' WHERE id=2;UPDATE experiences SET status='rejected',review_note='活动已取消' WHERE activity_id=2")
    assert.equal(count('activity.cancelled','c2'),1)
    assert.equal(count('experience.reviewed','c2'),0)
    activity(3,'取消报名的活动');addRegistration('c1',3)
    db.exec("INSERT INTO experiences(user_id,activity_id,title) VALUES('c1',3,'取消报名的活动')")
    const reviewsBefore=count('experience.reviewed','c1')
    db.exec("BEGIN;UPDATE registrations SET cancelled_at=1500 WHERE activity_id=3 AND user_id='c1';UPDATE experiences SET status='rejected',review_note='报名已取消',reviewed_by=NULL WHERE activity_id=3;COMMIT")
    assert.equal(count('registration.cancelled','c1'),1)
    assert.equal(count('experience.reviewed','c1'),reviewsBefore)
  }finally{db.close()}
})

test('自行培训重提提醒管理员，审核结果只给所有者，导航复核记录归属',()=>{
  const {db,api,users,count}=fixture()
  try{
    db.exec("INSERT INTO external_trainings(user_id,title) VALUES('c1','自行培训');UPDATE external_trainings SET status='rejected',review_note='补充材料' WHERE id=1")
    assert.equal(count('review.pending','a1'),1)
    assert.equal(count('external.reviewed','c1'),1);assert.equal(count('external.reviewed','c2'),0)
    db.exec("UPDATE external_trainings SET status='pending' WHERE id=1;UPDATE external_trainings SET status='pending' WHERE id=1")
    assert.equal(count('review.pending','a1'),2)
    db.exec("UPDATE external_trainings SET status='approved',credited_hours=2.25 WHERE id=1")
    assert.equal(count('external.reviewed','c1'),2)
    const own=api.list(users.c1,new URL('http://local')).rows.find(row=>row.kind==='external.reviewed')
    assert.equal(api.read(users.c1,own.id).target.url,'/pages/self-training/self-training?id=1')
    assert.throws(()=>api.read(users.c2,own.id),{status:404})
    const admin=api.list(users.a1,new URL('http://local')).rows[0]
    assert.equal(api.read(users.a1,admin.id).target.url,'/pages/reviews/reviews')
    db.exec("UPDATE external_trainings SET user_id='c2' WHERE id=1")
    assert.equal(api.read(users.c1,own.id).target,null)
  }finally{db.close()}
})

test('密码通知不保存明文或哈希；停用账号的安全通知保留至重新启用',()=>{
  const {db,api,users,count}=fixture()
  try{
    db.prepare('INSERT INTO credentials VALUES(?,?,1)').run('c1','initial-secret-hash')
    db.prepare('UPDATE credentials SET password_hash=?,must_change=0 WHERE user_id=?').run('personal-secret-hash','c1')
    assert.equal(count('security.password_reset','c1'),0)
    db.prepare('UPDATE credentials SET password_hash=?,must_change=1 WHERE user_id=?').run('reset-secret-hash','c1')
    db.prepare('UPDATE credentials SET password_hash=?,must_change=1 WHERE user_id=?').run('reset-secret-hash','c1')
    assert.equal(count('security.password_reset','c1'),1)
    db.prepare('INSERT INTO credentials VALUES(?,?,1)').run('off','disabled-secret-hash')
    db.prepare('UPDATE credentials SET password_hash=? WHERE user_id=?').run('disabled-reset-hash','off')
    assert.equal(count('security.password_reset','off'),1)
    assert.throws(()=>api.list(users.off,new URL('http://local')),{status:401})
    const json=JSON.stringify(db.prepare('SELECT * FROM notifications').all())+JSON.stringify(db.prepare('SELECT * FROM notification_events').all())
    for(const secret of ['initial-secret-hash','personal-secret-hash','reset-secret-hash','disabled-secret-hash','disabled-reset-hash'])assert.ok(!json.includes(secret))
  }finally{db.close()}
})

test('分页、未读计数和已读更新只作用当前账号，重复已读不产生二次写入',()=>{
  const {db,api,users,activity}=fixture()
  try{
    for(let i=1;i<=45;i++)activity(i,'培训'+i)
    const first=api.list(users.c1,new URL('http://local?limit=20'))
    assert.equal(first.rows.length,20);assert.equal(first.total,45);assert.equal(first.unreadCount,45)
    const all=[]
    for(let offset=0;offset<45;offset+=7)all.push(...api.list(users.c1,new URL('http://local?limit=7&offset='+offset)).rows.map(row=>row.id))
    assert.equal(all.length,45);assert.equal(new Set(all).size,45)
    assert.equal(api.read(users.c1,first.rows[0].id).changed,true)
    assert.equal(api.read(users.c1,first.rows[0].id).changed,false)
    assert.equal(api.unreadCount(users.c1),44);assert.equal(api.unreadCount(users.c2),45)
    assert.equal(api.readAll(users.c1).updated,44)
    assert.equal(api.list(users.c1,new URL('http://local?unread=1')).total,0)
    assert.equal(api.unreadCount(users.c2),45)
    assert.equal(api.readAll(users.c1).updated,0)
    assert.throws(()=>api.list(users.c1,new URL('http://local?limit=101')),{status:400})
    assert.throws(()=>api.list(users.c1,new URL('http://local?unread=yes')),{status:400})
    assert.throws(()=>api.read(users.c1,'1 OR 1=1'),{status:400})
  }finally{db.close()}
})

test('通知与业务变更同事务，回滚不留消息，通知失败时业务也失败',()=>{
  const {db,activity}=fixture()
  try{
    db.exec('BEGIN');activity();db.exec('ROLLBACK')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_events').get().n,0)
    db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON notifications WHEN NEW.kind='activity.published' BEGIN SELECT RAISE(ABORT,'notice unavailable');END")
    assert.throws(()=>activity(2))
    assert.equal(db.prepare('SELECT id FROM activities WHERE id=2').get(),undefined)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_events').get().n,0)
  }finally{db.close()}
})

test('分页快照排除中途插入的新通知，刷新后再展示新消息',()=>{
  const {db,api,users,activity}=fixture()
  try{
    for(let id=1;id<=25;id++)activity(id,'培训'+id)
    const first=api.list(users.c1,new URL('http://local?limit=10'))
    activity(26,'中途发布的新活动')
    const next=api.list(users.c1,new URL('http://local?limit=10&offset=10&snapshot='+first.snapshot))
    const last=api.list(users.c1,new URL('http://local?limit=10&offset=20&snapshot='+first.snapshot))
    assert.equal(next.total,25);assert.equal(next.unreadCount,26);assert.equal(next.hasNewer,true)
    const ids=[...first.rows,...next.rows,...last.rows].map(row=>row.id)
    assert.equal(ids.length,25);assert.equal(new Set(ids).size,25)
    assert.equal(api.list(users.c1,new URL('http://local')).rows[0].body.includes('中途发布的新活动'),true)
    assert.throws(()=>api.list(users.c1,new URL('http://local?snapshot=-1')),{status:400})
  }finally{db.close()}
})

test('旧报名表可初始化，升级取消字段后原子刷新触发器且不补发',()=>{
  const {db,count,activity,addRegistration}=fixture({legacy:true})
  try{
    activity();addRegistration('c1')
    const before=db.prepare('SELECT COUNT(*) n FROM notifications').get().n
    db.exec('ALTER TABLE registrations ADD COLUMN cancelled_at INTEGER')
    createNotifications(db)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n,before)
    db.exec("UPDATE registrations SET cancelled_at=1000 WHERE activity_id=1 AND user_id='c1'")
    assert.equal(count('registration.cancelled','c1'),1)
  }finally{db.close()}
})
