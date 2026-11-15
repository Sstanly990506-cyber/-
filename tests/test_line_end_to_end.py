"""Customer-group webhook, durable staff task, and reopening integration."""
import base64
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from api import line_bot, records, storage


class CustomerWebhookIntegrationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for obj, name, value in [
            (storage, 'DATABASE_URL', ''), (storage, 'DATA_DIR', Path(tmp.name)),
            (storage, 'ensure_storage', lambda: None), (records, 'RECORDS_PATH', Path(tmp.name) / 'records.json'),
            (records, 'RECORD_STORAGE_READY', True),
        ]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        env = patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'fixture-secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'fixture-token', 'LINE_ALLOWED_USER_IDS': ''})
        env.start(); self.addCleanup(env.stop)
        self.posts = []
        p = patch.object(line_bot, '_line_api_post', side_effect=lambda url, data: self.posts.append(data) or {'status': 200})
        p.start(); self.addCleanup(p.stop)
        records.upsert_record('lineDestinations', 'G1', {'id':'G1','destinationId':'G1','type':'group','active':True,'accessMode':'customer','customerName':'測試-公司'})
        records.upsert_record('orders', 'own', {'id':'own','orderNumber':'WO-1','itemName':'自己品名','billingCustomer':'測試-公司','status':'未完成','createdAt':'2026-11-15T01:00:00Z','orderDate':'2026-12-25'})
        records.upsert_record('orders', 'other', {'id':'other','orderNumber':'WO-2','itemName':'其他公司機密','billingCustomer':'測試公司','status':'未完成','createdAt':'2026-11-15T02:00:00Z'})

    def send(self, text, event_id, group='G1'):
        payload = {'events':[{'type':'message','webhookEventId':event_id,'replyToken':'test-reply',
                    'source':{'type':'group','groupId':group,'userId':'U1'},
                    'message':{'type':'text','text':text}}]}
        body = json.dumps(payload, ensure_ascii=False).encode()
        sig = base64.b64encode(hmac.new(b'fixture-secret', body, hashlib.sha256).digest()).decode()
        line_bot.handle_line_webhook(body, sig)

    def test_group_query_and_task_lifecycle_without_external_line_requests(self):
        self.send('我的工單好了嗎？', 'no-mention')
        self.assertEqual(self.posts, [])
        self.send('@三青 我的工單好了嗎？', 'list')
        msg = self.posts[-1]['messages'][0]
        self.assertIn('WO-1', msg['text']); self.assertIn('自己品名', msg['text'])
        self.assertNotIn('WO-2', msg['text']); self.assertNotIn('2026-12-25', msg['text'])
        self.assertTrue(all(a['action']['text'].startswith('@三青 ') for a in msg['quickReply']['items']))
        self.send('@三青 請問 WO-2 工單進度如何？', 'missing-1')
        self.assertIn('查不到', self.posts[-1]['messages'][0]['text'])
        self.send('@三青 請問 WO-2 工單進度如何？', 'missing-1')
        self.send('@三青 請問 WO-2 工單進度如何？', 'missing-2')
        tasks = records.all_records('events'); self.assertEqual(len(tasks), 1); self.assertEqual(tasks[0]['count'], 2)
        task = tasks[0]; version = task.pop('_updatedAt'); task.update(taskStatus='done', resolvedAt='2026-11-15T03:00:00Z', resolvedBy='員工')
        records.write_record_batch([('events', task['id'], task)], expected_versions={('events', task['id']):version})
        self.send('@三青 請問 WO-2 工單進度如何？', 'missing-3')
        task = records.get_record('events', task['id']); self.assertEqual(task['taskStatus'], 'pending')
        self.assertEqual(task['count'], 1); self.assertEqual(task['history'][0]['count'], 2)
        self.send('@三青 我的工單好了嗎？', 'new-group', group='G2')
        self.assertIn('尚未綁定', self.posts[-1]['messages'][0]['text'])
        self.assertEqual(records.get_record('lineDestinations', 'G2')['customerName'], '')
        self.assertEqual(len(records.all_records('events')), 2)
