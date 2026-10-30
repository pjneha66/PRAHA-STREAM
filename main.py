import streamlit as st

st.set_page_config(page_title="PRAHA STREAM", page_icon="▶", layout="centered")
st.title("PRAHA STREAM")
st.info(
    "PRAHA is a React + TypeScript application. Deploy `npm run build` with a static "
    "host such as Vercel, Netlify, Cloudflare Pages, or Render. Streamlit cannot run "
    "the Vite frontend or its Stremio/Nuvio web-worker runtime."
)
st.code("npm install\nnpm run dev", language="bash")
