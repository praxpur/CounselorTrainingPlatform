// 纯 HTTP 对照；--same-process 复现共用事件循环的影响。
require('./load-test').main([...process.argv.slice(2),'--probe','--cold']).catch(error=>{
  console.error(error.message)
  process.exitCode=1
})
