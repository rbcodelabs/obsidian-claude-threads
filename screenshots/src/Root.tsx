import { Composition } from 'remotion'
import { ClaudeThreadsShots } from './ClaudeThreadsShots'

export const Root = () => (
  <Composition
    id="ClaudeThreadsShots"
    component={ClaudeThreadsShots}
    durationInFrames={300}
    fps={30}
    width={1920}
    height={1080}
  />
)
