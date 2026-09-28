import { useState } from 'react'
import {
  KEYBOARD_LAYOUTS,
  LOCALES,
  TIMEZONES,
  randomPassword,
  sha512crypt,
  type UserSpec,
  type WifiSpec,
} from '@rsdk-webui/shared'
import { Button, Card, Chip, Field, Note, Select, TextInput, Toggle } from '../ui.tsx'
import type { StepProps } from './types.ts'

const SERVICES = [
  'ssh.service',
  'NetworkManager.service',
  'bluetooth.service',
  'avahi-daemon.service',
  'docker.service',
  'smbd.service',
  'chrony.service',
  'systemd-timesyncd.service',
]

export function SystemStep({ profile, patch }: StepProps) {
  const s = profile.system
  const [plainPassword, setPlainPassword] = useState('')
  const [hashState, setHashState] = useState<'idle' | 'busy' | 'ok' | string>('idle')

  const setSystem = (p: Partial<typeof s>) => patch({ system: { ...s, ...p } })

  const setUser = (p: Partial<UserSpec>) => {
    const base: UserSpec =
      s.user ?? { name: 'radxa', passwordHash: '', sudo: true, nopasswd: false, shell: '/bin/bash', sshKeys: [] }
    setSystem({ user: { ...base, ...p } })
  }

  const setWifi = (p: Partial<WifiSpec>) => {
    const base: WifiSpec = s.wifi ?? { ssid: '', psk: '', hidden: false, country: 'CN', autoconnect: true }
    setSystem({ wifi: { ...base, ...p } })
  }

  const applyPassword = async (value: string) => {
    setHashState('busy')
    try {
      // done here, in the browser: the plaintext never reaches any server, and
      // the backend-less (Pages) build has no server to ask anyway
      const hash = await sha512crypt(value)
      setUser({ passwordHash: hash })
      setHashState('ok')
    } catch (err) {
      setHashState(String(err instanceof Error ? err.message : err))
    }
  }

  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
      <div style={{ display: 'grid', gap: 16, alignContent: 'start', gridTemplateColumns: 'minmax(0,1fr)' }}>
      <Card title="系统标识">
        <div className="body">
          <div className="row">
            <Field label="主机名" desc="留空用 rsdk 默认（板子名）">
              <TextInput mono value={s.hostname} onChange={(v) => setSystem({ hostname: v })} placeholder="rock-5b" />
            </Field>
            <Field label="时区">
              <Select
                value={s.timezone}
                onChange={(v) => setSystem({ timezone: v })}
                options={[{ label: '保持不变', value: '' }, ...TIMEZONES.map((t) => ({ label: t, value: t }))]}
              />
            </Field>
          </div>
          <div className="row">
            <Field label="区域 / 语言">
              <Select
                value={s.locale}
                onChange={(v) => setSystem({ locale: v })}
                options={[{ label: '保持不变', value: '' }, ...LOCALES.map((t) => ({ label: t, value: t }))]}
              />
            </Field>
            <Field label="键盘布局">
              <Select
                value={s.keyboard.layout}
                onChange={(v) => setSystem({ keyboard: { ...s.keyboard, layout: v } })}
                options={KEYBOARD_LAYOUTS.map((t) => ({ label: t, value: t }))}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card
        title="首个用户"
        actions={
          s.user ? (
            <Button size="sm" variant="ghost" onClick={() => setSystem({ user: null })}>
              不需要
            </Button>
          ) : (
            <Button size="sm" onClick={() => setSystem({ user: { name: 'radxa', passwordHash: '', sudo: true, nopasswd: false, shell: '/bin/bash', sshKeys: [] } })}>
              + 创建用户
            </Button>
          )
        }
      >
        {s.user ? (
          <div className="body">
            <div className="row">
              <Field label="用户名">
                <TextInput mono value={s.user.name} onChange={(v) => setUser({ name: v })} />
              </Field>
              <Field label="登录 Shell">
                <TextInput mono value={s.user.shell} onChange={(v) => setUser({ shell: v })} />
              </Field>
            </div>
            <Field
              label="密码"
              desc="密码在浏览器里就哈希成 crypt(3) sha512，明文不出本机"
            >
              <div className="row tight">
                <TextInput
                  type="password"
                  value={plainPassword}
                  onChange={setPlainPassword}
                  placeholder="输入密码后点右侧按钮"
                />
                <div style={{ flex: 'none' }}>
                  <Button disabled={!plainPassword || hashState === 'busy'} onClick={() => void applyPassword(plainPassword)}>
                    {hashState === 'busy' ? '处理中…' : '生成哈希'}
                  </Button>
                </div>
                <div style={{ flex: 'none' }}>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const pw = await randomPassword()
                      setPlainPassword(pw)
                      await applyPassword(pw)
                    }}
                  >
                    随机
                  </Button>
                </div>
              </div>
            </Field>
            {s.user.passwordHash ? (
              <Note tone="ok">
                已设置密码哈希 <span className="mono">{s.user.passwordHash.slice(0, 24)}…</span>
              </Note>
            ) : (
              <Note tone="warn">未设置密码（账户将无法用密码登录）</Note>
            )}
            <hr className="sep" />
            <div className="toggle-list">
              <Toggle checked={s.user.sudo} onChange={(v) => setUser({ sudo: v })} title="加入 sudo 组" />
              <Toggle
                checked={s.user.nopasswd}
                onChange={(v) => setUser({ nopasswd: v })}
                disabled={!s.user.sudo}
                title="免密码 sudo"
                desc="写入 /etc/sudoers.d"
              />
            </div>
            <hr className="sep" />
            <Field label="该用户的 SSH 公钥" desc="每行一个，写入 ~/.ssh/authorized_keys (0600)">
              <textarea
                rows={3}
                value={s.user.sshKeys.join('\n')}
                onChange={(e) => setUser({ sshKeys: e.target.value.split('\n') })}
                placeholder="ssh-ed25519 AAAA... me@laptop"
              />
            </Field>
          </div>
        ) : (
          <div className="body">
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              只保留系统默认账户
            </p>
          </div>
        )}
      </Card>

      </div>

      <div style={{ display: 'grid', gap: 16, alignContent: 'start', gridTemplateColumns: 'minmax(0,1fr)' }}>
      <Card title="SSH">
        <div className="body">
          <div className="toggle-list">
            <Toggle checked={s.ssh.enabled} onChange={(v) => setSystem({ ssh: { ...s.ssh, enabled: v } })} title="开机启用 SSH" />
            <Toggle
              checked={s.ssh.passwordAuth}
              onChange={(v) => setSystem({ ssh: { ...s.ssh, passwordAuth: v } })}
              disabled={!s.ssh.enabled}
              title="允许密码登录"
              desc="关掉就只能用密钥登录（推荐）"
            />
          </div>
          <div style={{ height: 10 }} />
          <Field label="root 登录方式">
            <Select
              value={s.ssh.permitRootLogin}
              onChange={(v) => setSystem({ ssh: { ...s.ssh, permitRootLogin: v as 'yes' | 'no' | 'prohibit-password' } })}
              options={[
                { label: 'prohibit-password (仅密钥)', value: 'prohibit-password' },
                { label: 'no (完全禁止)', value: 'no' },
                { label: 'yes (允许密码)', value: 'yes' },
              ]}
            />
          </Field>
          <Field label="root 的 SSH 公钥" desc="每行一个">
            <textarea
              rows={3}
              value={s.ssh.rootAuthorizedKeys.join('\n')}
              onChange={(e) => setSystem({ ssh: { ...s.ssh, rootAuthorizedKeys: e.target.value.split('\n') } })}
              placeholder="ssh-ed25519 AAAA... me@laptop"
            />
          </Field>
        </div>
      </Card>

      <Card
        title="Wi-Fi"
        actions={
          s.wifi ? (
            <Button size="sm" variant="ghost" onClick={() => setSystem({ wifi: null })}>
              移除
            </Button>
          ) : (
            <Button size="sm" onClick={() => setWifi({})}>
              + 添加网络
            </Button>
          )
        }
      >
        {s.wifi ? (
          <div className="body">
            <div className="row">
              <Field label="SSID">
                <TextInput mono value={s.wifi.ssid} onChange={(v) => setWifi({ ssid: v })} />
              </Field>
              <Field label="密码">
                <TextInput type="password" value={s.wifi.psk} onChange={(v) => setWifi({ psk: v })} />
              </Field>
            </div>
            <div className="row">
              <Field label="国家码">
                <TextInput mono value={s.wifi.country} onChange={(v) => setWifi({ country: v })} />
              </Field>
              <Field label="隐藏网络">
                <Select
                  value={s.wifi.hidden ? 'yes' : 'no'}
                  onChange={(v) => setWifi({ hidden: v === 'yes' })}
                  options={[
                    { label: '否', value: 'no' },
                    { label: '是', value: 'yes' },
                  ]}
                />
              </Field>
            </div>
            <Toggle checked={s.wifi.autoconnect} onChange={(v) => setWifi({ autoconnect: v })} title="自动连接" />
            <div style={{ height: 12 }} />
            <Note tone="warn">
              明文写进镜像里的 <span className="mono">/etc/NetworkManager/system-connections/</span>（权限 0600）。
              这份 profile 推到公开仓库前记得删掉。
            </Note>
          </div>
        ) : (
          <div className="body">
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              不加 Wi-Fi，开机后自行连接。
            </p>
          </div>
        )}
      </Card>

      <Card title="启用 systemd 服务">
        <div className="body">
          <div className="chips" style={{ marginBottom: 12 }}>
            {SERVICES.map((svc) => {
              const on = s.enableServices.includes(svc)
              return (
                <button
                  key={svc}
                  className={`btn sm${on ? ' primary' : ''}`}
                  onClick={() =>
                    setSystem({
                      enableServices: on ? s.enableServices.filter((x) => x !== svc) : [...s.enableServices, svc],
                    })
                  }
                >
                  {svc.replace('.service', '')}
                </button>
              )
            })}
          </div>
          {s.enableServices.length > 0 && (
            <Field label="已选服务" displayOnly>
              <div className="chips">
                {s.enableServices.map((svc) => (
                  <Chip key={svc} tone="accent">
                    {svc}
                  </Chip>
                ))}
              </div>
            </Field>
          )}
          <p className="desc">
            离线创建 <span className="mono">multi-user.target.wants</span> 符号链接，不用在构建机里跑 systemd。
          </p>
        </div>
      </Card>
      </div>
    </div>
  )
}
