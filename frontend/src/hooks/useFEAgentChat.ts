import { useState, useCallback } from 'react'
import { askFEAgent, FEAgentMessage } from '../services/feAgent'

interface ChatEntry {
  role: 'user' | 'assistant'
  content: string
}

interface UseFEAgentChatReturn {
  chat: ChatEntry[]
  thinking: boolean
  streamingText: string
  handleSubmit: (question: string) => Promise<void>
}

export function useFEAgentChat(getSnapshot: () => string): UseFEAgentChatReturn {
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [thinking, setThinking] = useState(false)
  const [streamingText, setStreamingText] = useState('')

  const handleSubmit = useCallback(
    async (question: string) => {
      if (!question.trim() || thinking) return

      setChat((prev) => [...prev, { role: 'user', content: question }])
      setThinking(true)
      setStreamingText('')

      try {
        const snapshot = getSnapshot()
        const history: FEAgentMessage[] = chat.slice(-6).map((e) => ({
          role: e.role,
          content: e.content,
        }))

        const fullResponse = await askFEAgent(question, snapshot, history, (text) =>
          setStreamingText(text),
        )

        setChat((prev) => [...prev, { role: 'assistant', content: fullResponse }])
        setStreamingText('')
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error'
        setChat((prev) => [...prev, { role: 'assistant', content: `Error: ${errMsg}` }])
        setStreamingText('')
      } finally {
        setThinking(false)
      }
    },
    [thinking, chat, getSnapshot],
  )

  return { chat, thinking, streamingText, handleSubmit }
}
