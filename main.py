import streamlit as st

st.set_page_config(page_title="Parha Ultimate", page_icon="🎬", layout="centered")

st.title("🎬 Parha Ultimate Streaming App")

st.warning("""
**Deployment Notice:**
This application is a modern **React (JavaScript/TypeScript) application**, not a Python app.

Streamlit Community Cloud (`.streamlit.io`) is designed specifically for hosting Python applications and does not natively support React/Vite single-page applications like this one.

To deploy this app correctly, please use a hosting provider designed for modern web applications. We recommend:
- **Vercel** (https://vercel.com) - Highly recommended, easiest for React
- **Netlify** (https://netlify.com)
- **Render** (https://render.com)
- **Cloudflare Pages**

Alternatively, you can share or deploy the application directly from Google AI Studio using the Share menu.
""")
