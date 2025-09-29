import React, { useState } from 'react';
import { GroupOutlined, UserOutlined } from '@ant-design/icons';
import { Layout, Menu, theme, Button, Flex } from 'antd';

const { Header, Content, Footer, Sider } = Layout;

const userAndGroupIcons = [
  { key: 'user', label: 'Friend', icon: <UserOutlined /> },
  { key: 'group', label: 'Group', icon: <GroupOutlined /> },
];

const userList = [
  { key: 'u1', label: 'User Jeff', icon: <UserOutlined /> },
  { key: 'u2', label: 'User Tung', icon: <UserOutlined /> },
  { key: 'u3', label: 'User Tayaab', icon: <UserOutlined /> },
  { key: 'u4', label: 'User Kai', icon: <UserOutlined /> },
];

const groupList = [
  { key: 'g1', label: 'Group chatting', icon: <GroupOutlined /> },
];

function ChatPage() {
  const {
    token: { colorBgContainer, borderRadiusLG },
  } = theme.useToken();

  const [activeTab, setActiveTab] = useState('user');
  const rightMenuItems = activeTab === 'user' ? userList : groupList;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* Left menu to select user or group */}
      <Sider width={120} style={{ borderRight: '2px solid #909090' }}>
        <Menu
          theme="dark"
          mode="vertical"
          selectedKeys={[activeTab]}
          onClick={(e) => setActiveTab(e.key)}
          items={userAndGroupIcons}
        />
      </Sider>

      {/* Right menu */}
      <Sider width={150} style={{ borderRight: '2px solid #d2d2d2' }}>
        <Menu theme="dark" mode="vertical" items={rightMenuItems} />
      </Sider>

      <Layout>
        <Header style={{
          padding: 0, background: colorBgContainer, display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }} >
          <div style={{ fontWeight: 'bold', marginLeft: '40px' }}>User: Tom</div>
          <Button color="danger" variant="solid" style={{ marginRight: '20px' }}>Log out</Button>

        </Header>
        <Content style={{ margin: '24px 16px 0' }}>
          <div
            style={{
              padding: 24,
              minHeight: 550,
              background: colorBgContainer,
              borderRadius: borderRadiusLG,
            }}
          >
            Content
          </div>
        </Content>
        <Footer style={{ textAlign: 'center' }}>
          Chatting Room ©{new Date().getFullYear()} Created by Group 59
        </Footer>
      </Layout>
    </Layout>
  );
}

export default ChatPage;
