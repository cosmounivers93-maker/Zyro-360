// Device-specific FCM channels: NEVER infer support from a user's account.
// Old Android builds do not register a capability and must keep their legacy
// channels for important notifications, particularly SOS and theft alerts.
export const MODERN_CHANNEL_SET='zyro-v199';
export function notificationChannelFor(kind,channelSet){
  const modern=channelSet===MODERN_CHANNEL_SET;
  if(kind==='sos'||kind==='pickpocket')
    return modern?'zyro_sos_v199':'zyro_sos_v2';
  if(kind==='chat')
    return modern?'zyro_chat_v199':'zyro_chat_v2';
  if(kind==='journey')
    return modern?'zyro_journey_v199':'zyro_journey_v1';
  if(modern && ['warning','alert','checkin','admin-warning','report-warning'].includes(kind))
    return 'zyro_warning_v1';
  return modern?'zyro_updates_v199':'zyro_updates';
}
