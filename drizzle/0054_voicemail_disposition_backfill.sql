-- Historical voicemail backfill: dialer "Voicemail" dispositions were recorded
-- on lead_events (with meta.callRecordId) but never marked the call record, so
-- the Team page's voicemail counter stayed at zero. Stamp those records so
-- history counts correctly. (Voicemail SALES outcomes are counted at read
-- time by the analytics query — the telephony disposition is not derived from
-- them, since outcomes remain rep-editable.)
UPDATE call_records cr
SET disposition = 'voicemail'
FROM lead_events le
WHERE le.type = 'call'
  AND le.outcome ILIKE '%voicemail%'
  AND le.meta ->> 'callRecordId' = cr.id
  AND cr.disposition <> 'voicemail';
