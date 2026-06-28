-- ========================================
-- 🗣️  커뮤니티 게시판 — 스키마 (회원 + 게시글)
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 RUN 하세요.
-- (서버가 부팅 때 테이블을 자동 생성하므로 이 파일 실행은 선택사항입니다.)
--
-- ⚠️ 테이블 이름을 community_ 로 접두사 붙여, 같은 Supabase 프로젝트의
--    todos 앱(users/todos), my-food 앱(ingredients/recipes) 과 충돌하지 않게 격리했습니다.
--
-- 테이블 2개:
--   community_users  (회원: 이메일/비밀번호 해시/닉네임)
--   community_posts  (게시글: 작성자 → community_users, 제목/내용)
-- ========================================

-- gen_random_uuid() 사용을 위한 확장 (Supabase 엔 보통 이미 활성화돼 있음)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------
-- 회원
--   password_hash 는 bcrypt 해시 — 평문 비밀번호는 절대 저장하지 않습니다.
--   nickname 은 게시글에 "작성자 이름" 으로 표시됩니다.
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS community_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------
-- 게시글
--   user_id  : 작성자 (community_users.id 참조, 회원 탈퇴 시 글도 함께 삭제)
--   title    : 제목
--   content  : 내용
--   updated_at : 수정 시각 (수정할 때마다 갱신)
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS community_posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 목록은 최신순 정렬 → created_at 인덱스로 가속
CREATE INDEX IF NOT EXISTS idx_community_posts_created
  ON community_posts (created_at DESC);

-- 작성자별 글 조회 가속 (선택)
CREATE INDEX IF NOT EXISTS idx_community_posts_user
  ON community_posts (user_id);
