import unittest
from unittest.mock import patch
from api import line_bot

class CustomerFlowTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {'id':'a','orderNumber':'26A05P0127','itemName':'新品甲','billingCustomer':'新-公司','status':'未完成','createdAt':'2026-11-15T10:00:00.000Z','orderDate':'2026-12-31','totalPrice':998},
            {'id':'b','orderNumber':'260200','itemName':'新品乙','billingCustomer':'新-公司','status':'未完成','createdAt':'2026-11-15T11:00:00.000Z','orderDate':'2026-12-30'},
            {'id':'c','orderNumber':'260300','itemName':'完成項目','billingCustomer':'新-公司','status':'已完成','createdAt':'2026-11-15T09:00:00.000Z'},
            {'id':'d','orderNumber':'260400','itemName':'送出項目','billingCustomer':'新-公司','status':'已送出','createdAt':'2026-11-15T09:00:00.000Z'},
            {'id':'e','orderNumber':'260500','itemName':'其他公司秘密','billingCustomer':'新公司','status':'未完成','createdAt':'2026-11-15T12:00:00.000Z'},
            {'id':'f','orderNumber':'260600','itemName':'舊單','billingCustomer':'新-公司','status':'未完成','updatedAt':'2099-01-01'},
            {'id':'g','orderNumber':'260700','itemName':'取消項目','billingCustomer':'新-公司','status':'取消'},
        ]
        self.patcher=patch.object(line_bot,'all_records',side_effect=lambda entity,query='': list(self.rows));self.patcher.start();self.addCleanup(self.patcher.stop)
    def query(self,text):
        return line_bot._build_customer_portal_reply(text,'新-公司','G123456789','group','event-1')
    def test_natural_question_lists_only_own_pending_newest_first_without_dates_or_prices(self):
        response=self.query('我的工單好了嗎？')
        self.assertIn('260200 / 新品乙 / 未完成',response)
        self.assertLess(response.index('260200'),response.index('26A05P0127'))
        self.assertLess(response.index('26A05P0127'),response.index('260600'))
        self.assertIn('部分舊工單未記錄建立時間',response)
        for secret in ['其他公司秘密','260500','完成項目','送出項目','取消項目','2026-12-31','998']:
            self.assertNotIn(secret,response)
    def test_alphanumeric_number_natural_language_gives_status_only(self):
        response=self.query('請問26A05P0127工單現在進度如何？預計什麼時候完成？')
        self.assertIn('26A05P0127',response)
        self.assertIn('未完成',response)
        self.assertNotIn('品名',response)
        self.assertNotIn('2026-12-31',response)
        self.assertNotIn('預計',response)
    def test_cross_company_number_is_treated_as_not_found_and_creates_task(self):
        with patch('api.line_tasks.record_group_issue',return_value=True) as task:
            response=self.query('請問 260500 工單狀態？')
        self.assertNotIn('其他公司秘密',response)
        self.assertIn('查不到',response)
        task.assert_called_once_with('G123456789','order_not_found',order_number='260500',customer_name='新-公司',event_id='event-1')
    def test_no_task_and_no_claim_of_not_found_when_database_fails(self):
        with patch.object(line_bot,'all_records',side_effect=RuntimeError('offline')),patch('api.line_tasks.record_group_issue') as task:
            response=self.query('請問 260500 工單狀態？')
        self.assertIn('讀取未完成',response);task.assert_not_called()
    def test_failed_task_is_reported_and_never_silently_claimed_as_sent(self):
        with patch('api.line_tasks.record_group_issue',return_value=False):
            response=self.query('請問 999999 工單狀態？')
        self.assertIn('網站提醒未建立',response)
    def test_choose_completed_and_sent_without_mixing_statuses(self):
        complete=self.query('已完成工單');sent=self.query('已送出工單')
        self.assertIn('完成項目',complete);self.assertNotIn('新品乙',complete);self.assertNotIn('送出項目',complete)
        self.assertIn('送出項目',sent);self.assertNotIn('完成項目',sent)
    def test_paging_has_buttons_for_each_record_and_next_previous_are_mention_prefixed(self):
        self.rows=[{'orderNumber':f'WO-{n:03}','itemName':f'商品{n}','billingCustomer':'新-公司','status':'未完成','createdAt':f'2026-11-{n:02}T10:00:00Z'} for n in range(1,20)]
        page1=self.query('查工單');page2=self.query('未完成工單 第2頁');page3=self.query('未完成工單 第3頁')
        self.assertIn('第 1/3 頁',page1);self.assertIn('第 2/3 頁',page2);self.assertIn('第 3/3 頁',page3)
        for reply in [page1,page2,page3]:
            actions=line_bot._line_text_message(reply,access_mode='customer',shared=True)['quickReply']['items']
            self.assertLessEqual(len(actions),13)
            self.assertTrue(all(x['action']['text'].startswith('@三青 ') for x in actions))
            self.assertEqual(len(reply.order_numbers),len([x for x in actions if x['action']['text'].startswith('@三青 工單 ')]))
        self.assertIn('下一頁',[x['action']['label'] for x in line_bot._quick_reply_items('customer',True,page1)])
        self.assertIn('上一頁',[x['action']['label'] for x in line_bot._quick_reply_items('customer',True,page2)])
    def test_unbound_group_records_task_only_for_order_questions(self):
        with patch('api.line_tasks.record_group_issue',return_value=True) as task:
            result=line_bot._build_customer_portal_reply('工單進度','','G123456789','group','evt')
        self.assertIn('尚未指定客戶',result);task.assert_called_once_with('G123456789','unbound',event_id='evt')
    def test_unbound_reminder_failure_is_explicit(self):
        with patch('api.line_tasks.record_group_issue',return_value=False):
            result=line_bot._build_customer_portal_reply('查工單','','G123456789','group','evt')
        self.assertIn('網站提醒未建立',result)
    def test_non_group_queries_never_create_staff_tasks(self):
        with patch('api.line_tasks.record_group_issue') as task:
            line_bot._build_customer_portal_reply('查 999999 工單','新-公司','U123','user','evt')
        task.assert_not_called()
    def test_new_group_registration_is_conditional_and_never_overwrites_disabled_group(self):
        with patch.object(line_bot, 'get_record', return_value={'active': False}), patch.object(line_bot, 'write_record_batch') as write:
            line_bot._register_unseen_customer_group('G123456789', 'group')
            write.assert_not_called()
        with patch.object(line_bot, 'get_record', return_value=None), patch.object(line_bot, 'write_record_batch', side_effect=line_bot.RecordConflict('concurrent binding')) as write:
            line_bot._register_unseen_customer_group('G123456789', 'group')
            self.assertEqual(write.call_args.kwargs['expected_versions'], {('lineDestinations', 'G123456789'): 0})
            destination = write.call_args.args[0][0][2]
            self.assertEqual(destination['accessMode'], 'customer')
            self.assertEqual(destination['customerName'], '')
    def test_quick_reply_can_trigger_group_mention_filter(self):
        reply = self.query('查工單')
        actions = line_bot._line_text_message(reply, access_mode='customer', shared=True)['quickReply']['items']
        for item in actions:
            self.assertTrue(line_bot._should_reply_in_shared_chat(item['action']['text']))
    def test_group_join_and_unmentioned_messages_do_not_reply_or_create_tasks(self):
        join = {'type':'join','source':{'type':'group','groupId':'G123'},'replyToken':'r'}
        message = {'type':'message','source':{'type':'group','groupId':'G123'},'replyToken':'r','message':{'type':'text','text':'請問工單 123456 進度？'}}
        with patch.object(line_bot, '_reply') as reply, patch('api.line_tasks.record_group_issue') as task:
            line_bot._handle_event(join)
            line_bot._handle_event(message)
        reply.assert_not_called(); task.assert_not_called()

if __name__ == '__main__': unittest.main()
