import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
// 预制聊天组件与 Provider（@copilotkit/react-native 根入口，v1.69）
import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-native';

// Runtime 地址：EXPO_PUBLIC_* 会在 `npx expo start` 时从 .env 内联进 bundle。
// 真机（Expo Go）必须用电脑的局域网 IP，不能用 localhost。
const runtimeUrl =
  process.env.EXPO_PUBLIC_RUNTIME_URL || 'http://localhost:3001/api/copilotkit';

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <CopilotKitProvider runtimeUrl={runtimeUrl}>
        <View style={styles.container}>
          <CopilotChat
            agentName="pali_agent"
            headerTitle="法音 Pali-QA"
            placeholder="问一个巴利经文问题…"
            emptyStateTitle="巴利经文 AI 问答助手"
            emptyStateSubtitle="试试问：什么是四圣谛？缘起是什么？慈经讲了什么？"
          />
          <StatusBar style="auto" />
        </View>
      </CopilotKitProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: '#f7f3ea',
  },
});
