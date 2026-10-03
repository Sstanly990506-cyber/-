"""Read-only checks of the FAKE local demo. Never prints session credentials."""
import argparse
import http.client
import json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4173)
    parser.add_argument('--model', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise SystemExit('Invalid port')
    token = ''

    def call(path, payload=None):
        connection = http.client.HTTPConnection('127.0.0.1', args.port, timeout=180)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        try:
            connection.request('GET' if payload is None else 'POST', path, None if payload is None else json.dumps(payload), headers)
            response = connection.getresponse()
            body = response.read()
            if response.status != 200:
                raise RuntimeError('HTTP ' + str(response.status) + ' (response details intentionally hidden)')
            return json.loads(body)
        finally:
            connection.close()

    config = call('/api/local-ai/config')
    assert config['demo'], 'Refusing to run against a non-demo website'
    token = call('/api/local-ai/demo-session', {})['token']
    result = call('/api/local-ai/chat', {'question': '你好', 'mode': 'general'})
    assert result['found'] and '三青' in result['answer']
    print('PASS: local greeting')
    result = call('/api/local-ai/chat', {'question': 'DEMO-001', 'mode': 'data', 'entity': 'orders'})
    assert result['found'] and result['sources'] and 'DEMO-001' in result['answer']
    print('PASS: fake order + source')
    result = call('/api/local-ai/chat', {'question': '不存在的測試工單-XYZ', 'mode': 'data', 'entity': 'orders'})
    assert not result['found'] and '不知道' in result['answer']
    print('PASS: unknown data refusal')
    result = call('/api/local-ai/preview', {'recordId': 'demo-stock-1', 'note': '僅供預覽；測試不會確認或寫入這段文字。'})
    assert 'proposalId' in result and 'warning' in result
    print('PASS: inventory note preview (NOT committed)')
    if args.model:
        result = call('/api/local-ai/chat', {'question': 'QX-17 是什麼意思？', 'mode': 'documents'})
        assert result['found'] and result['sources'] and '標籤' in result['answer']
        print('PASS: real local RAG + source')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
