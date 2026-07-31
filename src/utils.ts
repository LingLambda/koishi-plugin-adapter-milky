import { Context, Universal, h } from 'koishi'
import { MilkyBot } from './bot'
import { Event, FriendEntity, GetLoginInfoOutput, GetUserProfileOutput, GroupEntity, GroupMemberEntity, IncomingMessage } from './generated/schema'
import { isNonNullable } from 'cosmokit'

export function decodeGroupChannel(group: GroupEntity): Universal.Channel {
  return {
    id: String(group.group_id),
    type: Universal.Channel.Type.TEXT,
    name: group.group_name
  }
}

export function decodePrivateChannel(user: GetUserProfileOutput, id: string): Universal.Channel {
  return {
    id,
    type: Universal.Channel.Type.DIRECT,
    name: user.nickname
  }
}

export function decodeGuild(group: GroupEntity): Universal.Guild {
  return {
    id: String(group.group_id),
    name: group.group_name,
    avatar: `https://p.qlogo.cn/gh/${group.group_id}/${group.group_id}/640`
  }
}

export function decodeGuildMember(member: GroupMemberEntity): Universal.GuildMember {
  return {
    user: {
      id: String(member.user_id),
      name: member.nickname,
      avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${member.user_id}&spec=640`
    },
    nick: member.card,
    avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${member.user_id}&spec=640`,
    joinedAt: member.join_time * 1000,
    roles: [{ id: member.role }]
  }
}

export function decodeUser(user: GetUserProfileOutput, id: string): Universal.User {
  return {
    id,
    name: user.nickname,
    avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=640`
  }
}

export function decodeFriend(friend: FriendEntity): Universal.Friend {
  return {
    user: {
      id: String(friend.user_id),
      name: friend.nickname,
      avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${friend.user_id}&spec=640`
    },
    nick: friend.remark
  }
}

export function decodeLoginUser(user: GetLoginInfoOutput): Universal.User {
  return {
    id: String(user.uin),
    name: user.nickname,
    avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${user.uin}&spec=640`
  }
}

export function decodeGuildChannelId(data: { message_scene: 'friend' | 'group' | 'temp', peer_id: number }): [string | undefined, string] {
  if (data.message_scene === 'group') {
    return [String(data.peer_id), String(data.peer_id)]
  } else if (data.message_scene === 'temp') {
    return [undefined, 'temporary:' + data.peer_id]
  } else {
    return [undefined, 'private:' + data.peer_id]
  }
}

export async function decodeMessage<C extends Context = Context>(
  bot: MilkyBot<C>,
  input: IncomingMessage,
  message: Universal.Message = {},
  payload: Universal.MessageLike = message
) {
  const [guildId, channelId] = decodeGuildChannelId(input)

  const elements: h[] = []
  for (const segment of input.segments) {
    const { type, data } = segment
    switch (type) {
      case 'text': {
        elements.push(h.text(data.text))
      }
        break
      case 'mention': {
        elements.push(h.at(data.user_id.toString(), { name: data.name }))
      }
        break
      case 'mention_all': {
        elements.push(h('at', { type: 'all' }))
      }
        break
      case 'reply': {
        message.quote = await bot.internal.getMessage(input.message_scene, input.peer_id, data.message_seq).then(data => {
          const message = decodeMessage(bot, data.message)
          if (!message) throw new Error('Message not found.')
          return message
        }).catch(error => {
          bot.logger.warn(error)
          return undefined
        })
      }
        break
      case 'image': {
        elements.push(h.image(data.temp_url, {
          width: data.width,
          height: data.height
        }))
      }
        break
      case 'record': {
        elements.push(h.audio(data.temp_url, {
          duration: data.duration
        }))
      }
        break
      case 'video': {
        elements.push(h.video(data.temp_url, {
          width: data.width,
          height: data.height,
          duration: data.duration
        }))
      }
        break
      case 'file': {
        let src: string
        if (data.file_hash) {
          src = (await bot.internal.getPrivateFileDownloadUrl(input.peer_id, data.file_id, data.file_hash)).download_url
        } else {
          src = (await bot.internal.getGroupFileDownloadUrl(input.peer_id, data.file_id)).download_url
        }
        elements.push(h.file(src, {
          title: data.file_name
        }))
      }
        break
      case 'light_app': {
        elements.push(
          h('milky:light-app', {
            appName: data.app_name,
            jsonPayload: data.json_payload
          })
        )
      }
        break
      case 'forward': {
        elements.push(
          h('milky:forward', {
            forwardId: data.forward_id,
            title: data.title,
            summary: data.summary
          })
        )
      }
        break
    }
  }

  if (elements.length === 0) return

  message.elements = elements
  message.content = elements.join('')
  message.id = encodeMessageIdByScene(input.message_scene, input.peer_id, input.message_seq)

  payload.timestamp = input.time * 1000
  payload.channel = {
    id: channelId,
    type: guildId ? Universal.Channel.Type.TEXT : Universal.Channel.Type.DIRECT
  }
  payload.user = {
    id: input.sender_id.toString(),
    avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${input.sender_id}&spec=640`
  }
  if (input.message_scene === 'group') {
    payload.guild = decodeGuild(input.group)
    payload.member = decodeGuildMember(input.group_member)
    payload.channel.name = input.group.group_name
    payload.user.name = input.group_member.nickname
  } else if (input.message_scene === 'friend') {
    payload.channel.name = input.friend.nickname
    payload.user.name = input.friend.nickname
  }
  return message
}

export async function adaptSession<C extends Context>(bot: MilkyBot<C>, body: Event) {
  const session = bot.session()
  session.setInternal('milky', body)

  switch (body.event_type) {
    case 'message_receive': {
      session.type = 'message'
      const message = await decodeMessage(bot, body.data, session.event.message = {}, session.event)
      if (!message) return
      break
    }
    case 'message_recall': {
      const [guildId, channelId] = decodeGuildChannelId(body.data)
      session.type = 'message-deleted'
      session.userId = String(body.data.sender_id)
      session.isDirect = body.data.message_scene !== 'group'
      session.channelId = channelId
      session.guildId = guildId
      session.messageId = encodeMessageIdByScene(body.data.message_scene, body.data.peer_id, body.data.message_seq)
      session.timestamp = body.time * 1000
      break
    }
    case 'friend_request': {
      session.type = 'friend-request'
      session.userId = String(body.data.initiator_id)
      session.channelId = `private:${session.userId}`
      session.messageId = `${body.data.initiator_uid}|0`
      session.content = body.data.comment
      session.timestamp = body.time * 1000
      break
    }
    case 'group_join_request': {
      session.type = 'guild-member-request'
      session.userId = String(body.data.initiator_id)
      session.channelId = String(body.data.group_id)
      session.guildId = String(body.data.group_id)
      session.messageId = `${body.data.notification_seq}|join_request|${body.data.group_id}|${body.data.is_filtered ? 1 : 0}`
      session.content = body.data.comment
      session.timestamp = body.time * 1000
      break
    }
    case 'group_invited_join_request': {
      session.type = 'guild-member-request'
      session.userId = String(body.data.target_user_id)
      session.channelId = String(body.data.group_id)
      session.guildId = String(body.data.group_id)
      session.messageId = `${body.data.notification_seq}|invited_join_request|${body.data.group_id}|0`
      session.content = ''
      session.timestamp = body.time * 1000
      break
    }
    case 'group_invitation': {
      session.type = 'guild-request'
      session.userId = String(body.data.initiator_id)
      session.channelId = String(body.data.group_id)
      session.guildId = String(body.data.group_id)
      session.messageId = `${body.data.invitation_seq}|0`
      session.content = ''
      session.timestamp = body.time * 1000
      break
    }
    case 'group_member_increase': {
      session.type = 'guild-member-added'
      session.userId = String(body.data.user_id)
      session.channelId = String(body.data.group_id)
      session.guildId = String(body.data.group_id)
      session.timestamp = body.time * 1000
      break
    }
    case 'group_member_decrease': {
      session.type = 'guild-member-removed'
      session.userId = String(body.data.user_id)
      session.channelId = String(body.data.group_id)
      session.guildId = String(body.data.group_id)
      session.timestamp = body.time * 1000
      break
    }
    case 'group_message_reaction': {
      session.type = body.data.is_add ? 'reaction-added' : 'reaction-removed'
      session.userId = String(body.data.user_id)
      session.guildId = String(body.data.group_id)
      session.channelId = String(body.data.group_id)
      session.messageId = encodeMessageIdByScene('group', body.data.group_id, body.data.message_seq)
      session.isDirect = false
      session.event.emoji = {
        id: `${body.data.reaction_type}|${body.data.face_id}`
      }
    }
  }

  if (session.type) return session
}

export function getSceneAndPeerId(channelId: string): ['friend' | 'group' | 'temp', number] {
  let scene: 'friend' | 'group' | 'temp'
  let peerId: number
  if (channelId.startsWith('temporary:')) {
    scene = 'temp'
    peerId = +channelId.replace('temporary:', '')
  } else if (channelId.startsWith('private:')) {
    scene = 'friend'
    peerId = +channelId.replace('private:', '')
  } else {
    scene = 'group'
    peerId = +channelId
  }
  return [scene, peerId]
}

/** QQ 消息场景与 chatType 的映射 */
export const MESSAGE_SCENE_TO_CHAT_TYPE: Record<'friend' | 'group' | 'temp', number> = {
  friend: 1,
  group: 2,
  temp: 1,
}

/** 编码后的消息 ID 所含字段 */
export interface EncodedMessageId {
  /** 聊天类型 */
  isGroup: boolean
  /** 对端 ID (群号 / 好友 QQ 号) */
  peerId: number
  /** 消息序号 */
  messageSeq: number
}

/**
 * 消息 ID 各字段的位宽布局 (总量 8 + 32 + 32 = 72 位):
 *   [71..64] chatType    8 位  (最高位, 取值 1/2, 将 ID 划分为少数固定桶)
 *   [63..32] peerId      32 位  (群号/QQ号未超过 2^32)
 *   [31.. 0] messageSeq  32 位  (最低位, 服务端单调递增, 单会话内 seq 上限定为 2^32)
 *
 * 关键设计: chatType 位于最高位且取值有限, 使同一会话 (chatType, peerId 固定) 下
 * messageSeq 的变化只影响低 32 位 (< 2^32), 相对 ~2^64 的高位基数为微小扰动,
 * 因此十进制字符串长度在单会话内基本恒定, 缓解「seq 增长 → ID 越来越长」的漂移。
 *
 * 残留漂移: 每个 chatType 桶值域 [chatType·2^64, (chatType+1)·2^64 - 1] 是否跨越 10^k 边界
 * 决定该桶长度是否恒定。由于 2^64 ≈ 1.8447e19 > 10^19, 故 chatType ≥ 1 的桶下界均已在
 * 20 位区间 [10^19, 10^20 - 1] 内:
 *   chatType=1 → [1.8e19, 3.7e19]  全在 20 位区间 → 20 位恒定
 *   chatType=2 → [3.7e19, 5.5e19]  全在 20 位区间 → 20 位恒定
 * 扩展性: chatType ≤ 4 均为 20 位恒定 (桶上界 < 10^20);
 *         chatType ≥ 5 起桶上界 ≥ 6·2^64 - 1 ≈ 1.1e20, 跨 10^20 进入 21 位。
 * 当前取值 1/2 全部落在 20 位恒定区间, 无残留漂移。
 *
 * encode 时对各字段施加对应位宽掩码, 防止越界值污染相邻字段。
 */
const CHAT_TYPE_SHIFT = 64n
const PEER_ID_SHIFT = 32n
const CHAT_TYPE_MASK = 0xffn
const PEER_ID_MASK = 0xffffffffn
const MESSAGE_SEQ_MASK = 0xffffffffn

/**
 * 将 chatType、peerId、messageSeq 按位打包为 BigInt 字符串作为消息 ID。
 * 结果为十进制字符串，无前缀。
 *
 * 注意: chatType 超过 8 位 (即 ≥ 256)、peerId 超过 32 位、messageSeq 超过 32 位
 * 均会被静默截断到对应位宽内, 避免污染相邻字段。
 */
export function encodeMessageId(chatType: number, peerId: number, messageSeq: number): string {
  const id =
    ((BigInt(chatType) & CHAT_TYPE_MASK) << CHAT_TYPE_SHIFT) |
    ((BigInt(peerId) & PEER_ID_MASK) << PEER_ID_SHIFT) |
    (BigInt(messageSeq) & MESSAGE_SEQ_MASK)
  return id.toString()
}

/**
 * 基于消息场景编码消息 ID，chatType 由 {@link MESSAGE_SCENE_TO_CHAT_TYPE} 自动推断。
 */
export function encodeMessageIdByScene(scene: 'friend' | 'group' | 'temp', peerId: number, messageSeq: number): string {
  return encodeMessageId(MESSAGE_SCENE_TO_CHAT_TYPE[scene], peerId, messageSeq)
}

/**
 * 解码由 {@link encodeMessageId} 生成的消息 ID 字符串。
 * 当传入的不是合法的编码字符串 (低于 2^64 阈值) 时返回 undefined。
 */
export function decodeMessageId(messageId: string): EncodedMessageId | undefined {
  let value: bigint
  try {
    value = BigInt(messageId)
  } catch {
    return undefined
  }
  // 合法编码值必 ≥ 2^64 (chatType ≥ 1); 低于此阈值的为非编码字符串。
  if (value < (1n << CHAT_TYPE_SHIFT)) return undefined
  return {
    messageSeq: Number(value & MESSAGE_SEQ_MASK),
    peerId: Number((value >> PEER_ID_SHIFT) & PEER_ID_MASK),
    isGroup: ((value >> CHAT_TYPE_SHIFT) & CHAT_TYPE_MASK) === 2n,
  }
}

export function filterNullable<T>(array: T[]) {
  return array.filter(e => isNonNullable(e))
}
