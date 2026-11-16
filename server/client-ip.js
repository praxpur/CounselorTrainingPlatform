const net = require('node:net')
const fail = (status,message) => { throw Object.assign(new Error(message),{status}) }
function normalize(value) {
  if(typeof value!=='string'||!net.isIP(value))fail(400,'客户端地址无效')
  const lowered=value.toLowerCase()
  if(lowered.startsWith('::ffff:')&&net.isIP(lowered.slice(7))===4)return lowered.slice(7)
  if(net.isIP(value)===4)return value
  try{
    const canonical=new URL('http://['+value+']/').hostname.slice(1,-1)
    const mapped=canonical.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
    if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return [high>>>8,high&255,low>>>8,low&255].join('.')}
    return canonical
  }
  catch{fail(400,'客户端地址无效')}
}
function clientIp(req,mode=process.env.TRUST_PROXY||'none') {
  if(!['none','loopback'].includes(mode))fail(503,'服务端代理配置无效')
  const peer=normalize(req.socket?.remoteAddress)
  const loopback=peer==='::1'||peer.startsWith('127.')
  if(mode!=='loopback'||!loopback)return peer
  const header=req.headers?.['x-real-ip']
  if(typeof header!=='string'||!header.trim())fail(400,'可信代理未提供客户端地址')
  return normalize(header.trim())
}
module.exports={clientIp}
