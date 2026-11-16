import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationChannelFor,MODERN_CHANNEL_SET} from '../fcm-channel-compat.mjs';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');

test('Old or unrecognized Android builds retain their original notification channels',()=>{
 const types={sos:'zyro_sos_v2',pickpocket:'zyro_sos_v2',
  chat:'zyro_chat_v2',journey:'zyro_journey_v1',
  checkin:'zyro_updates',warning:'zyro_updates',
  'admin-warning':'zyro_updates',general:'zyro_updates'};
 for(const capability of [undefined,null,'','unknown','v199',42]){
  for(const [kind,expected] of Object.entries(types))
   assert.equal(notificationChannelFor(kind,capability),expected,
    `${kind} capability=${capability}`);
 }
});
test('Only explicitly compatible Android builds receive new personalized channels',()=>{
 const types={sos:'zyro_sos_v199',pickpocket:'zyro_sos_v199',
 chat:'zyro_chat_v199',journey:'zyro_journey_v199',
 checkin:'zyro_warning_v1',warning:'zyro_warning_v1',
 'admin-warning':'zyro_warning_v1','report-warning':'zyro_warning_v1',
 general:'zyro_updates_v199'};
 for(const [kind,expected] of Object.entries(types))
  assert.equal(notificationChannelFor(kind,MODERN_CHANNEL_SET),expected);
});
test('FCM chooses the channel for each device token, not the recipient account',()=>{
 assert.match(server,/channelId:notificationChannelFor\(kind,entry\.notificationChannels\)/);
 assert.match(server,/req\.body\?\.notificationChannels===MODERN_CHANNEL_SET/);
 assert.match(server,/registered=\{token:deviceToken,session,at:now\(\),notificationChannels\}/);
 assert.match(server,/fcmEntriesFor\(userId\)/);
 assert.match(server,/token:entry\.token/);
 assert.match(server,/priority:'high',ttl:kind==='sos'/);
 assert.match(server,/if\s*\(!fcmReady\)\s*return/);
});
