import { DISTRO_MIRRORS, RADXA_MIRRORS, RADXA_MIRROR_HOSTS, type ExtraAptRepo } from '@rsdk-webui/shared'
import { Button, Card, Field, Note, Select, TextInput, Toggle } from '../ui.tsx'
import type { StepProps } from './types.ts'

function newRepo(): ExtraAptRepo {
  return {
    id: Math.random().toString(36).slice(2, 9),
    name: '',
    url: '',
    suite: '',
    components: ['main'],
    keyArmored: '',
    keyUrl: '',
    trusted: false,
    enabled: true,
  }
}

export function ReposStep({ profile, patch }: StepProps) {
  const repos = profile.repos

  const setRepos = (p: Partial<typeof repos>) => patch({ repos: { ...repos, ...p } })

  const updateRepo = (id: string, p: Partial<ExtraAptRepo>) =>
    setRepos({ extra: repos.extra.map((r) => (r.id === id ? { ...r, ...p } : r)) })

  const radxaIsThirdParty = repos.radxaMirror !== ''

  // 列表里已经滤掉了没有 radxa-deb 的站点，但用户可能从旧方案（或手改的
  // profile.json）里带进一个失效地址。另外 <select> 遇到不在选项里的值时会显示
  // 第一项，看起来像"官方源"，实际却在拿坏地址构建 —— 所以补一项把它显出来。
  const radxaHost = (() => {
    try {
      return new URL(repos.radxaMirror).host
    } catch {
      return ''
    }
  })()
  const radxaMirrorUnverified = repos.radxaMirror !== '' && !RADXA_MIRROR_HOSTS.includes(radxaHost)
  const radxaOptions = radxaMirrorUnverified
    ? [...RADXA_MIRRORS, { label: `未验证：${repos.radxaMirror}`, value: repos.radxaMirror }]
    : RADXA_MIRRORS

  return (
    <div className="grid-2">
      <Card title="Radxa 软件源 (radxa-deb)">
        <div className="body">
          <Field
            label="镜像地址"
            desc="留空用官方源。换第三方镜像会自动关掉 pkgs.json"
          >
            <Select
              value={repos.radxaMirror}
              onChange={(v) => setRepos({ radxaMirror: v, ...(v ? { usePkgsJson: false } : {}) })}
              options={radxaOptions}
            />
          </Field>
          <Toggle
            checked={repos.usePkgsJson}
            onChange={(v) => setRepos({ usePkgsJson: v })}
            disabled={radxaIsThirdParty}
            title="嵌入 pkgs.json 元数据"
            desc="带上包版本清单，后装软件好对齐版本。第三方镜像通常没有"
          />
          {radxaMirrorUnverified && (
            <div style={{ marginTop: 10 }}>
              <Note tone="warn">
                这个站没验证过。要是它没同步 radxa-deb，构建会在 apt-get update 阶段失败。
                实测可用：
                <span className="mono"> {RADXA_MIRROR_HOSTS.join(' / ')}</span>
              </Note>
            </div>
          )}
          <div style={{ height: 10 }} />
          <Toggle
            checked={repos.testRepo}
            onChange={(v) => setRepos({ testRepo: v })}
            title="使用测试源 (-test)"
            desc="对应 rsdk build --test-repo。包更新，也更可能出问题"
          />
        </div>
      </Card>

      <Card title="上游发行版源">
        <div className="body">
          <Field label="Debian / Ubuntu 镜像" desc="留空用上游默认源">
            <Select
              value={repos.distroMirror}
              onChange={(v) => setRepos({ distroMirror: v })}
              options={DISTRO_MIRRORS}
            />
          </Field>
          <Field
            label="快照时间戳"
            desc="用 snapshot.debian.org 的时间点，可复现。与镜像互斥"
          >
            <TextInput
              mono
              value={repos.snapshot}
              onChange={(v) => setRepos({ snapshot: v })}
              placeholder="20240101T000000Z"
            />
          </Field>
          {repos.snapshot && repos.distroMirror && (
            <Note tone="warn">快照与自定义镜像同时设置会被 rsdk 拒绝，请二选一。</Note>
          )}
        </div>
      </Card>

      <Card
        title="额外的 APT 源"
        hint={`${repos.extra.length} 个`}
        actions={
          <Button size="sm" onClick={() => setRepos({ extra: [...repos.extra, newRepo()] })}>
            + 添加源
          </Button>
        }
      >
        <div className="body">
          {repos.extra.length === 0 && (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              加 Radxa 官方源之外的第三方源，例如 apt.syncthing.net
            </p>
          )}
          {repos.extra.map((repo) => (
            <div key={repo.id} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line-soft)' }}>
              <div className="row">
                <Field label="名称">
                  <TextInput value={repo.name} onChange={(v) => updateRepo(repo.id, { name: v })} placeholder="syncthing" />
                </Field>
                <Field label="版本 (suite)">
                  <TextInput value={repo.suite} onChange={(v) => updateRepo(repo.id, { suite: v })} placeholder="stable" />
                </Field>
              </div>
              <Field label="仓库地址">
                <TextInput mono value={repo.url} onChange={(v) => updateRepo(repo.id, { url: v })} placeholder="https://apt.syncthing.net" />
              </Field>
              <div className="row">
                <Field label="组件 (空格分隔)">
                  <TextInput
                    mono
                    value={repo.components.join(' ')}
                    onChange={(v) => updateRepo(repo.id, { components: v.split(/\s+/).filter(Boolean) })}
                  />
                </Field>
                <Field label="签名密钥 URL" desc="留空就要粘公钥，或勾 trusted">
                  <TextInput mono value={repo.keyUrl} onChange={(v) => updateRepo(repo.id, { keyUrl: v })} placeholder="https://.../key.gpg" />
                </Field>
              </div>
              <Field label="或粘贴 ASCII-armored 公钥">
                <textarea
                  rows={3}
                  value={repo.keyArmored}
                  onChange={(e) => updateRepo(repo.id, { keyArmored: e.target.value })}
                  placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
                />
              </Field>
              <div className="row tight" style={{ alignItems: 'center' }}>
                <Toggle
                  checked={repo.trusted}
                  onChange={(v) => updateRepo(repo.id, { trusted: v })}
                  title="trusted=yes"
                  desc="跳过签名校验，确认后果再用"
                />
                <Toggle checked={repo.enabled} onChange={(v) => updateRepo(repo.id, { enabled: v })} title="启用" />
                <div style={{ flex: 'none' }}>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setRepos({ extra: repos.extra.filter((r) => r.id !== repo.id) })}
                  >
                    删除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
