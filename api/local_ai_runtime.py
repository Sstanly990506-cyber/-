"""Bridge to the sibling local AI; never imports an external AI SDK."""
import sys
from pathlib import Path

from api.service import ApiError


def load_local_engine():
    root = Path(__file__).resolve().parents[2] / 'sanqing-local-ai'
    source = root / 'src'
    if not (source / 'sanqing_ai' / 'answer.py').is_file():
        raise RuntimeError('找不到同層的 sanqing-local-ai 專案。')
    sys.path.insert(0, str(source))
    from sanqing_ai.answer import AnswerResult, answer_question, _simple_local_reply, _looks_like_company_question
    from sanqing_ai.config import Settings
    from sanqing_ai.security import contains_suspected_secret
    from sanqing_ai.launcher import _available_memory_gib, _assert_loopback_only, _preflight, _start_server, _stop_owned, LaunchError

    def answer(question, mode, history):
        if mode == 'general':
            greeting = _simple_local_reply(question)
            if greeting:
                return AnswerResult(True, greeting, (), 'general')
            if _looks_like_company_question(question):
                return AnswerResult(False, '公司內部資訊不能猜測。請切換「網站資料」查即時資料，或「文件查詢」查已匯入文件。', (), 'general')
        if _available_memory_gib() < 1.5:
            raise ApiError('可用記憶體不足 1.5 GiB。請先關閉不用的程式；網站資料查詢仍可使用。', 503)
        try:
            _preflight('chat')
            if _assert_loopback_only():
                raise ApiError('另一個 Ollama 工作正在執行。請先關閉終端機聊天或 Ollama 應用程式，再試一次。', 409)
            owned = _start_server()
            if owned is None:
                raise ApiError('Ollama 正被其他工作使用，請稍後再試。', 409)
        except LaunchError:
            raise ApiError('本機模型安全檢查未通過。請在 sanqing-local-ai 執行 start.cmd --check-only 檢查。', 503) from None
        try:
            prefix = '/文件 ' if mode == 'documents' else '/聊天 '
            return answer_question(prefix + question, settings=Settings(project_root=root), history=history)
        finally:
            _stop_owned(owned)

    return answer, contains_suspected_secret
