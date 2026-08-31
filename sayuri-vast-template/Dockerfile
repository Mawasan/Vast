FROM vastai/pytorch:latest

WORKDIR /workspace/sayuri
COPY . /workspace/sayuri
RUN chmod +x /workspace/sayuri/*.sh && PRELOAD_MODELS=0 /workspace/sayuri/provision.sh

# Vast SSH/Jupyter launch modes can replace CMD/ENTRYPOINT, so the Vast template
# also calls start.sh from its On-start Script.
CMD ["bash", "/workspace/sayuri/start.sh"]
